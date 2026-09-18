import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  MicToggle,
  RealtimeAudio,
  StartAudio,
  useRealtimeSessionContext,
  useTranscript,
  useTransportState,
} from 'cosmo-ai/react';

import { Board } from './Board';
import { atRisk, bustProbability } from './game/bot';
import { describeOption, HEIGHT } from './game/rules';
import type { GameStore } from './game/state';
import { Match } from './match';
import { StatusPill } from './StatusPill';
import type { SenderEvent } from './sender';
import { TurnPump } from './turn_pump';

type Props = {
  store: GameStore;
  warning: string | null;
  onEnd: () => void;
};

export function LiveView({ store, warning, onEnd }: Props) {
  const transport = useTransportState();
  const session = useRealtimeSessionContext();
  const [micWarning, setMicWarning] = useState<string | null>(null);

  const said = useTranscript();
  // Dots while it is forming a line. Without them a pause reads as a fault.
  const thinking = transport === 'ready' && said.length > 0 && said[said.length - 1]?.role === 'user';
  const game = useSyncExternalStore(
    useCallback((onChange: () => void) => store.subscribe(onChange), [store]),
    () => store.getState(),
  );

  // Built inside the effect, not in a ref: dispose() latches these off for
  // good, and StrictMode's mount/unmount/remount would otherwise hand the
  // live session a pump and a match that were already dead.
  const pumpRef = useRef<TurnPump | null>(null);
  const [trace, setTrace] = useState<SenderEvent[]>([]);

  useEffect(() => {
    const pump = new TurnPump(store, (event) =>
      setTrace((prev) => [event, ...prev].slice(0, 24)),
    );
    const match = new Match(store, pump);
    pumpRef.current = pump;
    pump.attach(session);

    const unsubscribe = store.subscribe(() => match.tick());
    match.tick();
    return () => {
      unsubscribe();
      match.dispose();
      pump.dispose();
      pumpRef.current = null;
    };
  }, [store, session]);

  const { phase, position } = game;
  const turn = phase.kind === 'game_over' ? null : phase.turn;
  const mine = turn !== null && store.controller(turn) === 'human';
  const who = turn === null ? '' : store.label(turn);

  const roll = useCallback(() => {
    if (turn === null) return;
    const lost = atRisk(store.getState().position, turn);
    const result = store.roll(turn);
    if (!result.ok) return;
    if (result.bust) {
      pumpRef.current?.note(
        `BUST — ${store.label(turn)} lost the whole turn, ${lost} square${
          lost === 1 ? '' : 's'
        } gone.`,
        true,
      );
      return;
    }
    pumpRef.current?.note(
      `${store.label(turn)} rolled ${result.dice.join('-')}. ` +
        `${result.options.length} legal way${result.options.length === 1 ? '' : 's'} to play it.`,
    );
  }, [store, turn]);

  const choose = useCallback(
    (index: number) => {
      if (turn === null) return;
      const result = store.choose(turn, index);
      if (!result.ok) return;
      const topped = [...store.getState().position.runners.entries()]
        .filter(([col, h]) => h === HEIGHT[col] && result.sums.includes(col))
        .map(([col]) => col);
      const after = store.getState().position;
      const risk = Math.round(bustProbability(after, turn) * 100);
      const held = atRisk(after, turn);
      pumpRef.current?.note(
        `${store.label(turn)} took ${result.sums.join(' and ')}.` +
          (topped.length > 0
            ? ` A runner is on top of column ${topped.join(', ')} — worth nothing unless they stop.`
            : '') +
          ` ${held} square${held === 1 ? '' : 's'} riding, ${risk}% to bust on the next roll, ` +
          'now deciding whether to bank.',
      );
    },
    [store, turn],
  );

  const stop = useCallback(() => {
    if (turn === null) return;
    const result = store.stop(turn);
    if (!result.ok) return;
    pumpRef.current?.note(
      `${store.label(turn)} stopped` +
        (result.columnsClosed.length > 0
          ? ` and closed column ${result.columnsClosed.join(', ')}`
          : '') +
        ', banking the turn.',
      true,
    );
  }, [store, turn]);

  return (
    <div className="game">
      <header className="top">
        <StatusPill transport={transport} warning={warning ?? micWarning} />
        <p className={`whose${mine ? ' mine' : ''}`}>
          {phase.kind === 'game_over' ? `${store.label(phase.winner)} won` : `${who} to play`}
        </p>
        <div className="controls">
          <MicToggle
            className="btn"
            label={{ muted: 'Unmute', unmuted: 'Mute' }}
            onError={() => {
              console.error('[runners] mic toggle failed');
              setMicWarning('The mic did not switch — check browser permissions.');
            }}
          />
          <button type="button" className="btn end" onClick={onEnd}>
            End game
          </button>
        </div>
      </header>

      <main className="stage">
        <Board position={position} seats={store.seats} />
        <aside className="side">
          <div className="says">
            {thinking && <p className="dots">···</p>}
            {said.length === 0 ? (
              <p className="hint">Cosmo is warming up…</p>
            ) : (
              // column-reverse pins the newest to the bottom, so the newest
              // has to come first in the DOM.
              [...said].reverse().map((line) => (
                <p key={line.id} className={line.role === 'user' ? 'me' : undefined}>
                  {line.text}
                </p>
              ))
            )}
          </div>
          <div className="log">
            {trace.map((event, i) => (
              <p key={i} className={`trace ${event.kind}`}>
                <b>{event.kind}</b> {event.detail}
              </p>
            ))}
          </div>
        </aside>
      </main>

      <footer className="bar">
        {phase.kind === 'game_over' ? (
          <p className="verdict">{store.label(phase.winner)} won.</p>
        ) : !mine ? (
          <p className="waiting">{who} is playing…</p>
        ) : phase.kind === 'awaiting_roll' ? (
          <>
            <button type="button" className="btn primary big" onClick={roll}>
              Roll
            </button>
            <button
              type="button"
              className="btn big"
              onClick={stop}
              disabled={turn === null || !store.canStop(turn)}
            >
              Stop &amp; bank
            </button>
          </>
        ) : (
          <>
            <span className="dice">
              {phase.dice.map((d, i) => (
                <b key={i}>{d}</b>
              ))}
            </span>
            {phase.options.map((option, i) => (
              <button key={i} type="button" className="btn primary" onClick={() => choose(i)}>
                {describeOption(option)}
                <span className="lands">
                  {[...option.runners.entries()]
                    .sort((a, b) => a[0] - b[0])
                    .map(([col, h]) => `${col}: ${h}/${HEIGHT[col]}`)
                    .join('   ')}
                </span>
              </button>
            ))}
          </>
        )}
      </footer>

      <RealtimeAudio />
      <StartAudio>
        {({ blocked, start }) =>
          blocked ? (
            <button type="button" className="btn unlock" onClick={() => void start()}>
              Tap to hear Cosmo
            </button>
          ) : null
        }
      </StartAudio>
    </div>
  );
}
