// The page's one AudioContext and the buses that hang off it. The context is created only inside
// unlock(), which callers run from a gesture: a context made before any gesture stays suspended
// and Chrome prints "The AudioContext was not allowed to start" about it, a line this page never
// wants in its console. Nothing here imports three.js or touches the DOM beyond the audio graph.

export interface AudioBuses {
  context: AudioContext;
  /** The loop's bus, a GainNode into the destination. */
  music: GainNode;
  /** The narration's bus (a later goal), same shape, unused here. */
  voice: GainNode;
}

export interface AudioEngine {
  /** The context and its buses once a gesture created them; null before. */
  readonly buses: AudioBuses | null;
  /**
   * Creates the context and the buses on the first call and resumes the context. Call it from a
   * gesture only. Resolves null when the browser keeps the context suspended.
   */
  unlock(): Promise<AudioBuses | null>;
  /** 'absent' before the context exists; the context's own state afterwards, on every change. */
  onStateChange(listener: (state: AudioContextState | 'absent') => void): () => void;
  /** Closes the context. */
  dispose(): void;
}

export function createAudioEngine(): AudioEngine {
  let buses: AudioBuses | null = null;
  const listeners = new Set<(state: AudioContextState | 'absent') => void>();

  function report(state: AudioContextState | 'absent'): void {
    for (const listener of listeners) {
      listener(state);
    }
  }

  return {
    get buses(): AudioBuses | null {
      return buses;
    },

    async unlock(): Promise<AudioBuses | null> {
      if (buses !== null) {
        // A later gesture after an interruption or a suspension: resume is what converts it back.
        try {
          await buses.context.resume();
        } catch {
          // The state check below is what decides; a rejected resume means it did not run.
        }
        return buses.context.state === 'running' ? buses : null;
      }
      try {
        const context = new AudioContext();
        const music = context.createGain();
        const voice = context.createGain();
        music.connect(context.destination);
        voice.connect(context.destination);
        buses = { context, music, voice };
        // iOS reports 'interrupted' after a phone call; it reaches the listeners like any other
        // state and the next gesture's resume is the way out.
        context.onstatechange = () => {
          report(context.state);
        };
        report(context.state);
        await context.resume();
      } catch {
        // A browser with no audio at all throws here; the caller reads it as "not running".
        return null;
      }
      return buses.context.state === 'running' ? buses : null;
    },

    onStateChange(listener: (state: AudioContextState | 'absent') => void): () => void {
      listeners.add(listener);
      listener(buses === null ? 'absent' : buses.context.state);
      return () => {
        listeners.delete(listener);
      };
    },

    dispose(): void {
      const closing = buses;
      listeners.clear();
      buses = null;
      if (closing !== null) {
        closing.context.onstatechange = null;
        // close() on an already closed context rejects; the page is going away either way.
        void closing.context.close().catch(() => undefined);
      }
    },
  };
}
