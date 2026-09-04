let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;
  if (!ctx) ctx = new AudioCtx();
  return ctx;
}

/** A soft two-tap mechanical shutter click, synthesized — no asset file needed. */
export function playShutterClick() {
  const audio = getContext();
  if (!audio) return;
  if (audio.state === "suspended") audio.resume();

  const tap = (time: number, freq: number, gain: number, dur: number) => {
    const osc = audio.createOscillator();
    const amp = audio.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(freq, time);
    amp.gain.setValueAtTime(0, time);
    amp.gain.linearRampToValueAtTime(gain, time + 0.002);
    amp.gain.exponentialRampToValueAtTime(0.0001, time + dur);
    osc.connect(amp);
    amp.connect(audio.destination);
    osc.start(time);
    osc.stop(time + dur + 0.02);
  };

  const now = audio.currentTime;
  tap(now, 1400, 0.05, 0.03);
  tap(now + 0.07, 820, 0.045, 0.05);
}
