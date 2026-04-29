import {
  type DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { atom, useAtom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';
import { useBeforeUnload, useInterval } from 'react-use';
import {
  ArrowDown,
  ArrowUp,
  BellRing,
  Check,
  GripVertical,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { Button } from './components/ui/Button.tsx';
import { Card } from './components/ui/Card.tsx';
import { Input } from './components/ui/Input.tsx';
import { Progress } from './components/ui/Progress.tsx';
import { cn } from './lib/utils.ts';

type TimerStep = {
  id: string;
  name: string;
  durationMs: number;
};

type DurationParts = {
  hours: number | string;
  minutes: number | string;
  seconds: number | string;
};

type SavedState = {
  timers?: Array<Partial<TimerStep>>;
};

type AlarmState = {
  timerName: string;
  expiredCount: number;
};

type AlarmVoice = {
  oscillators: OscillatorNode[];
  gain: GainNode;
};

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

const STORAGE_KEY = 'chain-timers:v1';
const TITLE_STORAGE_KEY = 'chain-timers:title';
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const STOP_CONFIRM_MS = 3000;

const starterTimers: TimerStep[] = [
  { id: crypto.randomUUID(), name: 'Slap and fold', durationMs: 30 * MINUTE },
  { id: crypto.randomUUID(), name: 'Lamination', durationMs: 45 * MINUTE },
  { id: crypto.randomUUID(), name: 'Stretch and fold 1', durationMs: 30 * MINUTE },
  { id: crypto.randomUUID(), name: 'Stretch and fold 2', durationMs: 30 * MINUTE },
  { id: crypto.randomUUID(), name: 'Preshape', durationMs: 3 * HOUR },
  { id: crypto.randomUUID(), name: 'Shape', durationMs: 25 * MINUTE },
];

function clampDuration(value: unknown): number {
  return Math.max(SECOND, Math.min(24 * HOUR, Number(value) || SECOND));
}

function formatTime(ms: number): string {
  const safeMs = Math.max(0, Math.ceil(ms / SECOND) * SECOND);
  const hours = Math.floor(safeMs / HOUR);
  const minutes = Math.floor((safeMs % HOUR) / MINUTE);
  const seconds = Math.floor((safeMs % MINUTE) / SECOND);
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];

  return parts.map((part) => String(part).padStart(2, '0')).join(':');
}

function durationParts(durationMs: number): DurationParts {
  return {
    hours: Math.floor(durationMs / HOUR),
    minutes: Math.floor((durationMs % HOUR) / MINUTE),
    seconds: Math.floor((durationMs % MINUTE) / SECOND),
  };
}

function durationFromParts(parts: DurationParts): number {
  return clampDuration(
    Number(parts.hours || 0) * HOUR +
    Number(parts.minutes || 0) * MINUTE +
    Number(parts.seconds || 0) * SECOND,
  );
}

function cleanDurationInput(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (!digits) return '';
  return String(Number(digits));
}

function normalizeTimers(value: unknown): TimerStep[] | null {
  const timers = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as SavedState).timers)
      ? (value as SavedState).timers
      : null;

  if (!timers || timers.length === 0) return null;

  return timers.map((timer) => ({
    id: typeof timer.id === 'string' ? timer.id : crypto.randomUUID(),
    name: typeof timer.name === 'string' && timer.name.trim() ? timer.name : 'Untitled step',
    durationMs: clampDuration(timer.durationMs),
  }));
}

const timerStorage = {
  getItem: (key: string, initialValue: TimerStep[]) => {
    try {
      const saved = localStorage.getItem(key);
      if (!saved) return initialValue;
      return normalizeTimers(JSON.parse(saved)) ?? initialValue;
    } catch {
      localStorage.removeItem(key);
      return initialValue;
    }
  },
  setItem: (key: string, value: TimerStep[]) => {
    localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem: (key: string) => {
    localStorage.removeItem(key);
  },
};

const timersAtom = atomWithStorage<TimerStep[]>(STORAGE_KEY, starterTimers, timerStorage, {
  getOnInit: true,
});

const chainTitleAtom = atomWithStorage(TITLE_STORAGE_KEY, 'Chain timers', undefined, {
  getOnInit: true,
});
const completedIdsAtom = atom<string[]>([]);

function useAlarmSound() {
  const audioContextRef = useRef<AudioContext | null>(null);
  const alarmVoicesRef = useRef<AlarmVoice[]>([]);
  const alarmPulseRef = useRef<number | null>(null);

  const getAudioContext = useCallback((): AudioContext | null => {
    try {
      const BrowserAudioContext = window.AudioContext || window.webkitAudioContext;
      if (!BrowserAudioContext) return null;

      const context = audioContextRef.current || new BrowserAudioContext();
      audioContextRef.current = context;
      void context.resume();

      return context;
    } catch {
      return null;
    }
  }, []);

  const playBellNote = useCallback(
    (context: AudioContext, startAt: number, frequency: number, volume: number) => {
      try {
        const fundamental = context.createOscillator();
        const overtone = context.createOscillator();
        const gain = context.createGain();
        const detune = Math.random() * 8 - 4;
        const stopAt = startAt + 1.25;

        fundamental.type = 'sine';
        overtone.type = 'triangle';
        fundamental.frequency.setValueAtTime(frequency, startAt);
        overtone.frequency.setValueAtTime(frequency * 2.01, startAt);
        fundamental.detune.setValueAtTime(detune, startAt);
        overtone.detune.setValueAtTime(detune * 0.6, startAt);
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.exponentialRampToValueAtTime(volume, startAt + 0.025);
        gain.gain.exponentialRampToValueAtTime(0.0001, stopAt);

        fundamental.connect(gain);
        overtone.connect(gain);
        gain.connect(context.destination);
        fundamental.start(startAt);
        overtone.start(startAt);
        fundamental.stop(stopAt);
        overtone.stop(stopAt);

        const voice = { oscillators: [fundamental, overtone], gain };
        alarmVoicesRef.current.push(voice);
        window.setTimeout(() => {
          voice.oscillators.forEach((oscillator) => oscillator.disconnect());
          voice.gain.disconnect();
          alarmVoicesRef.current = alarmVoicesRef.current.filter((item) => item !== voice);
        }, Math.ceil((stopAt - context.currentTime) * 1000) + 100);
      } catch {
        // Audio is optional and can be blocked by browser settings.
      }
    },
    [],
  );

  const startAlarmSound = useCallback(() => {
    if (alarmPulseRef.current) return;

    const context = getAudioContext();
    if (!context) return;

    const playPattern = () => {
      const now = context.currentTime;
      const drift = Math.random() * 0.045;
      playBellNote(context, now, 523.25, 0.075);
      playBellNote(context, now + 0.28 + drift, 659.25, 0.06);
      playBellNote(context, now + 0.62 + drift, 783.99, 0.055);
    };

    playPattern();
    alarmPulseRef.current = window.setInterval(playPattern, 2800);
  }, [getAudioContext, playBellNote]);

  const stopAlarmSound = useCallback((): void => {
    if (alarmPulseRef.current) {
      window.clearInterval(alarmPulseRef.current);
      alarmPulseRef.current = null;
    }

    alarmVoicesRef.current.forEach((voice) => {
      voice.oscillators.forEach((oscillator) => {
        try {
          oscillator.stop();
        } catch {
          // The oscillator may already be stopped by the browser.
        }
        oscillator.disconnect();
      });
      voice.gain.disconnect();
    });
    alarmVoicesRef.current = [];
  }, []);

  useEffect(() => stopAlarmSound, [stopAlarmSound]);

  return { getAudioContext, startAlarmSound, stopAlarmSound };
}

function useTimerCountdown({
  activeId,
  endsAt,
  isPaused,
  onExpire,
  setRemainingMs,
}: {
  activeId: string | null;
  endsAt: number | null;
  isPaused: boolean;
  onExpire: () => void;
  setRemainingMs: (value: number) => void;
}) {
  useInterval(
    () => {
      if (!endsAt) return;

      const nextRemaining = endsAt - Date.now();
      if (nextRemaining <= 0) {
        onExpire();
        return;
      }
      setRemainingMs(nextRemaining);
    },
    activeId && !isPaused && endsAt ? 250 : null,
  );
}

function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export default function App() {
  const [timers, setTimers] = useAtom(timersAtom);
  const [chainTitle, setChainTitle] = useAtom(chainTitleAtom);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [completedIds, setCompletedIds] = useAtom(completedIdsAtom);
  const [isPaused, setIsPaused] = useState(false);
  const [alarm, setAlarm] = useState<AlarmState | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [isStopConfirming, setIsStopConfirming] = useState(false);
  const stopConfirmTimeoutRef = useRef<number | null>(null);
  const { getAudioContext, startAlarmSound, stopAlarmSound } = useAlarmSound();

  const activeIndex = timers.findIndex((timer) => timer.id === activeId);
  const activeTimer = activeIndex >= 0 ? timers[activeIndex] : null;
  const isChainRunning = Boolean(activeTimer);
  const completedTaskCount = completedIds.length;
  const totalTaskCount = timers.length;
  const totalDuration = useMemo(
    () => timers.reduce((sum, timer) => sum + timer.durationMs, 0),
    [timers],
  );
  const completedDuration = useMemo(
    () =>
      timers.reduce((sum, timer) => {
        if (completedIds.includes(timer.id)) return sum + timer.durationMs;
        if (timer.id === activeId) return sum + timer.durationMs - remainingMs;
        return sum;
      }, 0),
    [activeId, completedIds, remainingMs, timers],
  );
  const progress = totalDuration > 0 ? (completedDuration / totalDuration) * 100 : 0;
  const totalRemainingMs = Math.max(0, totalDuration - completedDuration);

  useBeforeUnload(isChainRunning);
  useTimerCountdown({
    activeId,
    endsAt,
    isPaused,
    onExpire: finishTimer,
    setRemainingMs,
  });
  useDocumentTitle(activeTimer ? `${formatTime(remainingMs)} - ${chainTitle || 'Chain timers'}` : chainTitle || 'Chain timers');

  function triggerAlarm(timerName: string): void {
    setAlarm((current) => ({
      timerName,
      expiredCount: current ? current.expiredCount + 1 : 1,
    }));
    startAlarmSound();
  }

  function stopAlarm(): void {
    stopAlarmSound();
    setAlarm(null);
  }

  function updateTimer(id: string, patch: Partial<Pick<TimerStep, 'name'>>): void {
    if (isChainRunning) return;

    setTimers((current) =>
      current.map((timer) => (timer.id === id ? { ...timer, ...patch } : timer)),
    );
  }

  function updateDuration(id: string, field: keyof DurationParts, value: string): void {
    if (isChainRunning) return;

    const cleanValue = cleanDurationInput(value);

    setTimers((current) =>
      current.map((timer) => {
        if (timer.id !== id) return timer;
        const parts = durationParts(timer.durationMs);
        return {
          ...timer,
          durationMs: durationFromParts({ ...parts, [field]: cleanValue }),
        };
      }),
    );
  }

  function addTimer(): void {
    if (isChainRunning) return;

    setTimers((current) => [
      ...current,
      { id: crypto.randomUUID(), name: 'New step', durationMs: 30 * MINUTE },
    ]);
  }

  function removeTimer(id: string): void {
    if (isChainRunning) return;

    setTimers((current) => current.filter((timer) => timer.id !== id));
    setCompletedIds((current) => current.filter((completedId) => completedId !== id));
    if (activeId === id) stopChain();
  }

  function moveTimer(id: string, direction: -1 | 1): void {
    if (isChainRunning) return;

    setTimers((current) => {
      const index = current.findIndex((timer) => timer.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function reorderTimer(draggedTimerId: string, targetTimerId: string): void {
    if (isChainRunning) return;
    if (draggedTimerId === targetTimerId) return;

    setTimers((current) => {
      const draggedIndex = current.findIndex((timer) => timer.id === draggedTimerId);
      const targetIndex = current.findIndex((timer) => timer.id === targetTimerId);
      if (draggedIndex < 0 || targetIndex < 0) return current;

      const next = [...current];
      const [draggedTimer] = next.splice(draggedIndex, 1);
      next.splice(targetIndex, 0, draggedTimer);
      return next;
    });
  }

  function handleDragStart(event: DragEvent<HTMLButtonElement>, id: string): void {
    if (isChainRunning) {
      event.preventDefault();
      return;
    }

    setDraggedId(id);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', id);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>, id: string): void {
    if (isChainRunning) return;

    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverId(id);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>, id: string): void {
    if (isChainRunning) return;

    event.preventDefault();
    const droppedId = draggedId || event.dataTransfer.getData('text/plain');
    if (droppedId) reorderTimer(droppedId, id);
    setDraggedId(null);
    setDragOverId(null);
  }

  function finishDrag(): void {
    setDraggedId(null);
    setDragOverId(null);
  }

  function startTimer(id: string): void {
    if (isChainRunning) return;

    const timerIndex = timers.findIndex((item) => item.id === id);
    const timer = timers[timerIndex];
    if (!timer) return;
    if (stopConfirmTimeoutRef.current) window.clearTimeout(stopConfirmTimeoutRef.current);
    setIsStopConfirming(false);
    stopConfirmTimeoutRef.current = null;
    getAudioContext();
    setActiveId(id);
    setCompletedIds(timers.slice(0, timerIndex).map((item) => item.id));
    setRemainingMs(timer.durationMs);
    setEndsAt(Date.now() + timer.durationMs);
    setIsPaused(false);
  }

  function finishTimer(): void {
    if (!activeTimer) return;

    triggerAlarm(activeTimer.name);
    setCompletedIds((current) =>
      current.includes(activeTimer.id) ? current : [...current, activeTimer.id],
    );

    const nextTimer = timers[activeIndex + 1];
    if (nextTimer) {
      if (stopConfirmTimeoutRef.current) window.clearTimeout(stopConfirmTimeoutRef.current);
      setIsStopConfirming(false);
      stopConfirmTimeoutRef.current = null;
      setActiveId(nextTimer.id);
      setRemainingMs(nextTimer.durationMs);
      setEndsAt(Date.now() + nextTimer.durationMs);
      setIsPaused(false);
      return;
    }

    setActiveId(null);
    setRemainingMs(0);
    setEndsAt(null);
    setIsPaused(false);
    setCompletedIds([]);
  }

  function pauseOrResume(): void {
    if (!activeTimer) return;
    if (isPaused) {
      setEndsAt(Date.now() + remainingMs);
      setIsPaused(false);
      return;
    }
    setRemainingMs(Math.max(0, (endsAt ?? Date.now()) - Date.now()));
    setEndsAt(null);
    setIsPaused(true);
  }

  function stopChain(): void {
    if (stopConfirmTimeoutRef.current) window.clearTimeout(stopConfirmTimeoutRef.current);
    setIsStopConfirming(false);
    stopConfirmTimeoutRef.current = null;
    setActiveId(null);
    setRemainingMs(0);
    setEndsAt(null);
    setIsPaused(false);
  }

  function requestStopChain(): void {
    if (!activeTimer) return;
    if (isStopConfirming) {
      stopChain();
      return;
    }

    if (stopConfirmTimeoutRef.current) window.clearTimeout(stopConfirmTimeoutRef.current);
    setIsStopConfirming(true);
    stopConfirmTimeoutRef.current = window.setTimeout(() => {
      setIsStopConfirming(false);
      stopConfirmTimeoutRef.current = null;
    }, STOP_CONFIRM_MS);
  }

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,rgba(169,95,54,0.12),transparent_340px),#f7f3ec] p-3.5 sm:p-6">
      <section className="mx-auto w-full max-w-6xl" aria-label="Chain timers workspace">
        {alarm ? (
          <div
            className="fixed inset-0 z-50 grid place-items-center bg-stone-950/55 p-4"
            role="dialog"
            aria-modal="true"
            aria-labelledby="timer-alarm-title"
          >
            <Card className="w-full max-w-md border-amber-500 bg-card p-5 shadow-2xl shadow-stone-950/30">
              <div className="mb-4 flex items-start gap-3">
                <div className="grid size-12 shrink-0 place-items-center rounded-full bg-amber-500 text-stone-950">
                  <BellRing size={24} aria-hidden="true" />
                </div>
                <div>
                  <p className="mb-1 text-xs font-extrabold uppercase text-amber-800">
                    Timer expired
                  </p>
                  <h2
                    id="timer-alarm-title"
                    className="text-2xl font-black leading-tight tracking-normal text-foreground"
                  >
                    {alarm.timerName}
                  </h2>
                </div>
              </div>
              {alarm.expiredCount > 1 ? (
                <p className="mb-4 text-sm font-bold text-muted-foreground">
                  {alarm.expiredCount} timers have expired since the alarm started.
                </p>
              ) : null}
              <Button className="w-full" type="button" onClick={stopAlarm}>
                <BellRing size={18} aria-hidden="true" />
                <span>Stop alarm</span>
              </Button>
            </Card>
          </div>
        ) : null}

        <Card className="mb-4 bg-card/90 p-5 shadow-xl shadow-stone-900/5">
          <div className="min-w-0 flex-1">
            <p className="mb-2 text-xs font-extrabold uppercase text-amber-800">Chain timers</p>
            <div className="flex min-w-0 items-center gap-4">
              <img
                className="size-14 shrink-0 rounded-2xl shadow-lg shadow-stone-900/10 sm:size-20"
                src="/favicon.svg"
                alt=""
                aria-hidden="true"
              />
              <input
                aria-label="Chain name"
                className="block w-full rounded-lg border border-transparent bg-transparent p-0 text-4xl font-black leading-none tracking-normal text-foreground outline-none transition focus:border-input focus:bg-background/60 focus:px-2 focus:py-1 focus:ring-2 focus:ring-ring sm:text-6xl lg:text-7xl"
                value={chainTitle}
                placeholder="Chain timers"
                onChange={(event) => setChainTitle(event.target.value)}
              />
            </div>
          </div>
        </Card>

        <Card
          className="mb-4 grid items-end gap-5 bg-card p-5 shadow-xl shadow-stone-900/5 sm:grid-cols-[1fr_auto] sm:p-6"
          aria-label="Current timer"
        >
          <div>
            <p className="mb-1 text-xs font-extrabold uppercase text-amber-800">
              {activeTimer ? 'Now running' : 'Ready'}
            </p>
            <h2 className="text-2xl font-black leading-tight tracking-normal text-foreground sm:text-4xl">
              {activeTimer ? activeTimer.name : 'Choose any timer to start'}
            </h2>
          </div>
          <div
            className="font-mono text-6xl font-black leading-none text-primary sm:text-7xl lg:text-8xl"
            aria-live="polite"
          >
            {activeTimer ? formatTime(remainingMs) : formatTime(totalDuration)}
          </div>
          <Progress className="sm:col-span-2" value={progress} aria-label="Overall chain progress" />
          <div className="flex flex-wrap gap-2.5 sm:col-span-2" aria-live="polite">
            <div className="rounded-lg bg-secondary px-3 py-2 text-sm font-black text-secondary-foreground">
              {completedTaskCount}/{totalTaskCount} done
            </div>
            <div className="rounded-lg bg-secondary px-3 py-2 text-sm font-black text-secondary-foreground">
              Total remaining {formatTime(totalRemainingMs)}
            </div>
          </div>
          <div className="flex flex-wrap gap-2.5 sm:col-span-2">
            <Button type="button" onClick={pauseOrResume} disabled={!activeTimer}>
              {isPaused ? <Play size={18} /> : <Pause size={18} />}
              <span>{isPaused ? 'Resume' : 'Pause'}</span>
            </Button>
            <Button
              type="button"
              onClick={requestStopChain}
              disabled={!activeTimer}
              variant={isStopConfirming ? 'destructive' : 'default'}
            >
              <RotateCcw size={18} />
              <span>{isStopConfirming ? 'Click again to stop' : 'Stop'}</span>
            </Button>
          </div>
        </Card>

        <section className="grid gap-3" aria-label="Editable chain timers">
          {timers.map((timer, index) => {
            const parts = durationParts(timer.durationMs);
            const isActive = timer.id === activeId;
            const isCompleted = completedIds.includes(timer.id);
            const isDragging = timer.id === draggedId;
            const isDragTarget = timer.id === dragOverId && timer.id !== draggedId;

            return (
              <Card
                className={cn(
                  'grid items-start gap-3 bg-card/95 p-4 shadow-xl shadow-stone-900/5 transition sm:grid-cols-[96px_minmax(0,1fr)_auto] sm:gap-4',
                  isActive && 'border-amber-500 bg-amber-50 shadow-amber-900/15',
                  isCompleted && 'bg-green-100 opacity-50',
                  isDragging && 'opacity-55',
                  isDragTarget && 'border-amber-600 ring-2 ring-amber-500/45',
                )}
                key={timer.id}
                onDragOver={(event) => handleDragOver(event, timer.id)}
                onDragLeave={() => setDragOverId((current) => (current === timer.id ? null : current))}
                onDrop={(event) => handleDrop(event, timer.id)}
              >
                <div className="grid w-fit grid-cols-[36px_44px] items-center gap-2 sm:pt-6">
                  <button
                    className="grid size-9 cursor-grab place-items-center rounded-lg text-muted-foreground hover:bg-secondary hover:text-secondary-foreground active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                    type="button"
                    draggable={!isChainRunning}
                    disabled={isChainRunning}
                    aria-label={`Drag ${timer.name}`}
                    title="Drag to reorder"
                    onDragStart={(event) => handleDragStart(event, timer.id)}
                    onDragEnd={finishDrag}
                  >
                    <GripVertical size={18} aria-hidden="true" />
                  </button>
                  <div
                    className={cn(
                      'grid size-11 place-items-center rounded-full bg-secondary text-sm font-black text-amber-900 tabular-nums',
                      isCompleted && 'bg-green-700 text-white',
                      isActive && !isCompleted && 'bg-amber-500 text-stone-950',
                    )}
                  >
                    {isCompleted ? <Check size={18} /> : String(index + 1).padStart(2, '0')}
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-[minmax(180px,1fr)_minmax(260px,0.8fr)]">
                  <label className="grid grid-rows-[16px_44px] gap-1.5">
                    <span className="self-end text-xs font-extrabold text-muted-foreground">Name</span>
                    <Input
                      value={timer.name}
                      disabled={isChainRunning}
                      onChange={(event) => updateTimer(timer.id, { name: event.target.value })}
                    />
                  </label>

                  <div className="grid grid-cols-3 gap-2" aria-label={`${timer.name} duration`}>
                    <label className="grid grid-rows-[16px_44px] gap-1.5">
                      <span className="self-end text-xs font-extrabold text-muted-foreground">Hours</span>
                      <Input
                        inputMode="numeric"
                        min="0"
                        pattern="[0-9]*"
                        type="text"
                        value={parts.hours}
                        disabled={isChainRunning}
                        onChange={(event) => updateDuration(timer.id, 'hours', event.target.value)}
                      />
                    </label>
                    <label className="grid grid-rows-[16px_44px] gap-1.5">
                      <span className="self-end text-xs font-extrabold text-muted-foreground">Minutes</span>
                      <Input
                        inputMode="numeric"
                        min="0"
                        max="59"
                        pattern="[0-9]*"
                        type="text"
                        value={parts.minutes}
                        disabled={isChainRunning}
                        onChange={(event) =>
                          updateDuration(timer.id, 'minutes', event.target.value)
                        }
                      />
                    </label>
                    <label className="grid grid-rows-[16px_44px] gap-1.5">
                      <span className="self-end text-xs font-extrabold text-muted-foreground">Seconds</span>
                      <Input
                        inputMode="numeric"
                        min="0"
                        max="59"
                        pattern="[0-9]*"
                        type="text"
                        value={parts.seconds}
                        disabled={isChainRunning}
                        onChange={(event) =>
                          updateDuration(timer.id, 'seconds', event.target.value)
                        }
                      />
                    </label>
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-2 sm:pt-6">
                  <Button
                    aria-label={`Start ${timer.name}`}
                    size="icon"
                    type="button"
                    disabled={isChainRunning}
                    onClick={() => startTimer(timer.id)}
                    title={`Start ${timer.name}`}
                  >
                    <Play size={18} />
                  </Button>
                  <Button
                    aria-label={`Move ${timer.name} up`}
                    size="icon"
                    variant="secondary"
                    type="button"
                    disabled={isChainRunning || index === 0}
                    onClick={() => moveTimer(timer.id, -1)}
                    title="Move up"
                  >
                    <ArrowUp size={18} />
                  </Button>
                  <Button
                    aria-label={`Move ${timer.name} down`}
                    size="icon"
                    variant="secondary"
                    type="button"
                    disabled={isChainRunning || index === timers.length - 1}
                    onClick={() => moveTimer(timer.id, 1)}
                    title="Move down"
                  >
                    <ArrowDown size={18} />
                  </Button>
                  <Button
                    aria-label={`Delete ${timer.name}`}
                    size="icon"
                    variant="destructive"
                    type="button"
                    disabled={isChainRunning}
                    onClick={() => removeTimer(timer.id)}
                    title="Delete"
                  >
                    <Trash2 size={18} />
                  </Button>
                </div>
              </Card>
            );
          })}
          <button
            type="button"
            className="grid min-h-24 items-center gap-3 rounded-lg border-2 border-dashed border-border bg-card/60 p-4 text-left text-muted-foreground transition hover:border-amber-500 hover:bg-amber-50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:border-border disabled:hover:bg-card/60 disabled:hover:text-muted-foreground sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-4"
            disabled={isChainRunning}
            onClick={addTimer}
          >
            <span className="grid w-fit grid-cols-[36px_44px] items-center gap-2">
              <span className="size-9" aria-hidden="true" />
              <span className="grid size-11 place-items-center rounded-full bg-secondary text-amber-900">
                <Plus size={20} aria-hidden="true" />
              </span>
            </span>
            <span>
              <span className="block text-sm font-black text-foreground">Add timer</span>
              <span className="mt-1 block text-sm font-bold text-muted-foreground">
                Add a new step to this chain
              </span>
            </span>
          </button>
        </section>
      </section>
    </main>
  );
}
