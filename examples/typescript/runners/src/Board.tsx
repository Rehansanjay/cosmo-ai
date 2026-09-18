import { COLUMNS, HEIGHT, type Position } from './game/rules';
import type { Seats } from './game/state';

type Props = { position: Position; seats: Seats };

/**
 * The eleven columns, tallest in the middle. Each square carries at most one
 * mark, in priority order: the runner standing there this turn, then whoever
 * has banked that high. A closed column dims whole.
 */
export function Board({ position, seats }: Props) {
  const tallest = Math.max(...COLUMNS.map((c) => HEIGHT[c]));

  return (
    <div className="boardwrap">
      <div className="legend">
        <span className="key p1">{seats.p1.label}</span>
        <span className="key p2">{seats.p2.label}</span>
        <span className="key runner">Runners this turn</span>
      </div>
      <div className="board">
        {COLUMNS.map((col) => {
        const closedBy = position.claims[col];
        const runner = position.runners.get(col);
        const p1 = position.progress.p1[col] ?? 0;
        const p2 = position.progress.p2[col] ?? 0;
        const squares = Array.from({ length: HEIGHT[col] }, (_, i) => HEIGHT[col] - i);

        return (
          <div
            key={col}
            className={`col${closedBy === undefined ? '' : ` closed closed-${closedBy}`}`}
            style={{ paddingTop: `${(tallest - HEIGHT[col]) * 1.23}rem` }}
          >
            <div className="track">
              {squares.map((square) => {
                const marks = [
                  runner === square ? 'runner' : null,
                  p1 === square ? 'p1' : null,
                  p2 === square ? 'p2' : null,
                ].filter((m): m is string => m !== null);
                const top = square === HEIGHT[col];
                return (
                  <div
                    key={square}
                    className={`sq${top ? ' top' : ''}${marks.length > 0 ? ` ${marks.join(' ')}` : ''}`}
                  />
                );
              })}
            </div>
              <div className="col-label">{col}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
