import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import {
  AZURE_LOCALE,
  buildSsml,
  DEFAULT_RECOGNITION_CONFIG,
  parseLanguageTag,
  type Language,
} from '@frontly/shared';
import {
  TELEPHONY_SAMPLE_RATE,
  type ISpeechProvider,
  type ISpeechToText,
  type ITextToSpeech,
  type SpeechToTextOptions,
  type SynthesisRequest,
} from './types.js';

/**
 * Azure Speech, wired for a phone line.
 *
 * The one thing that makes this simpler than it looks: Azure can emit
 * `Raw8Khz8BitMonoMULaw`, which is byte-for-byte what Twilio wants on the
 * wire. No resampling, no transcoding, no WAV header to strip — synthesized
 * bytes go straight into a media frame.
 */

export interface AzureSpeechOptions {
  key: string;
  region: string;
}

export class AzureSpeechProvider implements ISpeechProvider {
  constructor(private readonly options: AzureSpeechOptions) {}

  private speechConfig(): sdk.SpeechConfig {
    const config = sdk.SpeechConfig.fromSubscription(this.options.key, this.options.region);
    // Raw mulaw: Twilio's exact wire format.
    config.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Raw8Khz8BitMonoMULaw;
    /**
     * Detailed output, purely to get a confidence score.
     *
     * Simple output returns no confidence at all, and the code that consumed
     * it defaulted to 1.0 — so the "I didn't catch that, shall I put you
     * through?" path could never trigger, no matter how badly a call was
     * going. A requirement that cannot fire is not implemented.
     */
    config.outputFormat = sdk.OutputFormat.Detailed;
    return config;
  }

  createSynthesizer(): ITextToSpeech {
    return new AzureTextToSpeech(this.speechConfig());
  }

  createRecognizer(options: SpeechToTextOptions): ISpeechToText {
    return new AzureSpeechToText(this.speechConfig(), options);
  }
}

// --- text to speech ----------------------------------------------------------

class AzureTextToSpeech implements ITextToSpeech {
  private synthesizer: sdk.SpeechSynthesizer;

  constructor(config: sdk.SpeechConfig) {
    // `null` audio output: give me the bytes, do not open a speaker. On a
    // server the default output device either does not exist or is worse.
    this.synthesizer = new sdk.SpeechSynthesizer(config, null);
  }

  async synthesize(request: SynthesisRequest): Promise<Buffer> {
    // Always SSML. Plain text silently drops the prosody rate that makes the
    // agent intelligible on an 8 kHz line.
    const ssml = buildSsml(request.text, request.language, request.profile, {
      ...(request.breakAfterFirstSentence ? { breakAfterFirstSentence: true } : {}),
    });

    const result = await new Promise<sdk.SpeechSynthesisResult>((resolve, reject) => {
      this.synthesizer.speakSsmlAsync(ssml, resolve, (error) => reject(new Error(error)));
    });

    if (result.reason === sdk.ResultReason.Canceled) {
      const details = sdk.CancellationDetails.fromResult(result);
      throw new Error(`Azure TTS cancelled: ${details.reason} ${details.errorDetails ?? ''}`.trim());
    }
    if (result.reason !== sdk.ResultReason.SynthesizingAudioCompleted) {
      throw new Error(`Azure TTS returned ${sdk.ResultReason[result.reason]}`);
    }

    return Buffer.from(result.audioData);
  }

  close(): void {
    this.synthesizer.close();
  }
}

// --- speech to text ----------------------------------------------------------

class AzureSpeechToText implements ISpeechToText {
  private readonly pushStream: sdk.PushAudioInputStream;
  private readonly recognizer: sdk.SpeechRecognizer;
  private stopped = false;
  /**
   * startContinuousRecognitionAsync resolves asynchronously, but Twilio starts
   * sending audio the instant the socket opens. Anything written before the
   * recognizer is live is discarded — and that is exactly the caller's opening
   * words, which is both their first sentence and the sample that language
   * detection runs on. So buffer until it is ready.
   */
  private started = false;
  /** Set by speechEndDetected, read to measure the finalizing silence. */
  private speechEndedAt: number | undefined;
  private pending: ArrayBuffer[] = [];
  /** 10 seconds of frames — vastly more than startup needs, still bounded. */
  private static readonly MAX_PENDING_FRAMES = 500;

  public readonly ready: Promise<void>;
  private markReady!: () => void;

  constructor(config: sdk.SpeechConfig, options: SpeechToTextOptions) {
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });

    // Tell Azure the bytes are mulaw so it does not try to parse them as PCM.
    const format = sdk.AudioStreamFormat.getWaveFormat(
      TELEPHONY_SAMPLE_RATE,
      8,
      1,
      sdk.AudioFormatTag.MuLaw,
    );
    this.pushStream = sdk.AudioInputStream.createPushStream(format);
    const audioConfig = sdk.AudioConfig.fromStreamInput(this.pushStream);

    /**
     * When Azure decides the caller has finished.
     *
     * Its default segmentation ends a phrase after 500 ms of silence, which is
     * shorter than the pause someone takes while working out which day suits
     * them — so the agent answered a half-finished sentence and talked over
     * the rest. The silence timeout is only honoured under the "Time"
     * strategy, so the strategy is set explicitly rather than left to default.
     */
    const recognition = options.recognition ?? DEFAULT_RECOGNITION_CONFIG;
    config.setProperty(
      sdk.PropertyId.Speech_SegmentationStrategy,
      recognition.segmentationStrategy,
    );
    if (recognition.segmentationStrategy === 'Time') {
      config.setProperty(
        sdk.PropertyId.Speech_SegmentationSilenceTimeoutMs,
        String(recognition.segmentationSilenceMs),
      );
      // Azure requires the silence timeout to be set before it honours this,
      // and it caps a caller who never pauses for breath.
      config.setProperty(
        sdk.PropertyId.Speech_SegmentationMaximumTimeMs,
        String(recognition.segmentationMaximumMs),
      );
    }

    const locales = options.languages.map((l) => AZURE_LOCALE[l]);

    if (locales.length > 1) {
      // Auto-detection for the caller's first utterance. AtStart decides once
      // from the opening audio, which is exactly the product rule — detect,
      // then lock — and is cheaper than re-deciding every utterance.
      config.setProperty(sdk.PropertyId.SpeechServiceConnection_LanguageIdMode, 'AtStart');
      const detect = sdk.AutoDetectSourceLanguageConfig.fromLanguages(locales);
      this.recognizer = sdk.SpeechRecognizer.FromConfig(config, detect, audioConfig);
    } else {
      // Language already locked: skip detection, which costs latency.
      config.speechRecognitionLanguage = locales[0] ?? AZURE_LOCALE.mk;
      this.recognizer = new sdk.SpeechRecognizer(config, audioConfig);
    }

    /**
     * Bias towards the vocabulary this clinic actually uses.
     *
     * Applied after the recognizer exists and before recognition starts —
     * phrases take effect from the next recognition, so setting them here
     * covers the caller's opening words. A weight above 1.0 leans harder on
     * the list, which is what a narrow domain over 8 kHz wants.
     */
    if (options.phrases && options.phrases.length > 0) {
      const grammar = sdk.PhraseListGrammar.fromRecognizer(this.recognizer);
      grammar.addPhrases(options.phrases);
      grammar.setWeight(recognition.phraseListWeight);
      options.onDiagnostic?.(
        { phrases: options.phrases.length, weight: recognition.phraseListWeight },
        'phrase list applied',
      );
    }

    this.wireHandlers(options);
    this.recognizer.startContinuousRecognitionAsync(
      () => {
        this.started = true;
        for (const pending of this.pending) this.pushStream.write(pending);
        this.pending = [];
        this.markReady();
      },
      (error) => {
        this.markReady(); // never leave a caller awaiting a recognizer that failed
        options.handlers.onError(new Error(`Azure STT failed to start: ${error}`));
      },
    );
  }

  private wireHandlers(options: SpeechToTextOptions): void {
    const { handlers } = options;
    const recognition = options.recognition ?? DEFAULT_RECOGNITION_CONFIG;

    // Energy, not words. Enough to arm barge-in, never enough to confirm it.
    this.recognizer.speechStartDetected = () => {
      this.speechEndedAt = undefined;
      handlers.onSpeechStarted?.();
    };

    this.recognizer.speechEndDetected = () => {
      this.speechEndedAt = Date.now();
      handlers.onSpeechEnded?.();
    };

    this.recognizer.recognizing = (_sender, event) => {
      if (event.result.text) handlers.onPartial?.(event.result.text);
    };

    /**
     * Only a final result starts a turn.
     *
     * `recognizing` fires continuously with unstable hypotheses; acting on one
     * would answer a sentence the caller is halfway through saying. This
     * handler is the single path to onFinal, and it accepts nothing but
     * RecognizedSpeech.
     */
    this.recognizer.recognized = (_sender, event) => {
      const { result } = event;
      if (result.reason !== sdk.ResultReason.RecognizedSpeech) return;
      if (!result.text.trim()) return;

      // How long the line was quiet before Azure called it. If this equals the
      // configured timeout on a turn that felt interrupted, the timeout is too
      // low for this speaker — which is the whole point of logging it.
      const endSilenceMs = this.speechEndedAt ? Date.now() - this.speechEndedAt : undefined;
      const utteranceMs = Number(result.duration) / 10_000 || undefined;

      options.onDiagnostic?.(
        {
          text: result.text.trim(),
          confidence: extractConfidence(result),
          endSilenceMs,
          utteranceMs: utteranceMs ? Math.round(utteranceMs) : undefined,
          configuredSilenceMs: recognition.segmentationSilenceMs,
          strategy: recognition.segmentationStrategy,
        },
        'utterance finalized',
      );

      this.speechEndedAt = undefined;
      handlers.onFinal({
        text: result.text.trim(),
        confidence: extractConfidence(result),
        detectedLanguage: extractLanguage(result, options.languages),
        endSilenceMs,
        ...(utteranceMs ? { utteranceMs: Math.round(utteranceMs) } : {}),
      });
    };

    this.recognizer.canceled = (_sender, event) => {
      if (event.reason === sdk.CancellationReason.EndOfStream) return;
      handlers.onError(
        new Error(`Azure STT cancelled: ${event.errorDetails || sdk.CancellationReason[event.reason]}`),
      );
    };
  }

  write(mulaw: Buffer): void {
    if (this.stopped) return;
    // Copy into a standalone ArrayBuffer: a Node Buffer is a view into a
    // shared pool, and handing the pool to the SDK feeds it other people's
    // audio.
    const copy = new ArrayBuffer(mulaw.byteLength);
    new Uint8Array(copy).set(mulaw);

    if (!this.started) {
      // Bounded, so a recognizer that never starts cannot grow without limit.
      if (this.pending.length < AzureSpeechToText.MAX_PENDING_FRAMES) this.pending.push(copy);
      return;
    }
    this.pushStream.write(copy);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.pending = [];
    this.markReady();
    this.pushStream.close();
    await new Promise<void>((resolve) => {
      this.recognizer.stopContinuousRecognitionAsync(
        () => resolve(),
        () => resolve(),
      );
    });
    this.recognizer.close();
  }
}

/**
 * Azure does not return a confidence score unless detailed output is asked
 * for, and detailed output costs latency on every turn. The JSON payload
 * carries one when it is there; a recognized-but-unscored result is treated as
 * confident, because Azure only emits RecognizedSpeech when it is.
 */
function extractConfidence(result: sdk.SpeechRecognitionResult): number {
  try {
    const raw = result.properties.getProperty(
      sdk.PropertyId.SpeechServiceResponse_JsonResult,
      '',
    );
    if (!raw) return 1;
    const parsed = JSON.parse(raw) as { NBest?: { Confidence?: number }[] };
    const best = parsed.NBest?.[0]?.Confidence;
    return typeof best === 'number' ? best : 1;
  } catch {
    return 1;
  }
}

function extractLanguage(
  result: sdk.SpeechRecognitionResult,
  candidates: Language[],
): Language | undefined {
  if (candidates.length <= 1) return undefined;
  try {
    const detected = sdk.AutoDetectSourceLanguageResult.fromResult(result).language;
    const language = parseLanguageTag(detected);
    // Never return something outside the business's configured languages.
    return language && candidates.includes(language) ? language : undefined;
  } catch {
    return undefined;
  }
}
