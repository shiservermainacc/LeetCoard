import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useRef, type CSSProperties } from "react";
import type { LeaderboardRow, ProblemPayload } from "../../lib/types";
import { difficultyColor, userColor } from "../../lib/color";

interface Props {
  rows: LeaderboardRow[];
  problems: ProblemPayload[];
}

const LEADER_PERIMETER_POINTS = [
  [9, 9], [56, 8], [102, 10], [148, 7], [194, 9], [240, 6], [286, 9], [332, 7],
  [378, 10], [424, 6], [470, 9], [516, 7], [562, 10], [608, 6], [654, 9], [700, 7],
  [746, 10], [792, 6], [838, 9], [884, 7], [930, 10], [990, 8], [992, 28], [989, 49],
  [993, 70], [990, 92], [944, 90], [898, 94], [852, 91], [806, 95], [760, 92], [714, 96],
  [668, 91], [622, 95], [576, 92], [530, 96], [484, 91], [438, 95], [392, 92], [346, 96],
  [300, 91], [254, 95], [208, 92], [162, 96], [116, 91], [70, 95], [10, 92], [8, 72],
  [11, 51], [7, 30],
] as const;

function randomUnit(seed: number, salt: number) {
  const value = Math.sin((seed + salt * 17.31) * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

function usernameSeed(username: string) {
  let hash = 2166136261;
  for (const character of username) {
    hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  }
  return (hash >>> 0) / 1_000_000;
}

function createPerimeterVariants(seed: number, count = 5) {
  return Array.from({ length: count }, (_, variantIndex) => {
    const points = LEADER_PERIMETER_POINTS.map(([x, y], pointIndex) => {
      const amplitude = 1.8 + randomUnit(seed, variantIndex * 70 + pointIndex) * 1.6;
      const offset = (randomUnit(seed, variantIndex * 90 + pointIndex + 400) - 0.5) * amplitude * 2;
      if (y < 20 && x > 30 && x < 970) return [x, y + offset] as const;
      if (y > 80 && x > 30 && x < 970) return [x, y + offset] as const;
      if ((x < 20 || x > 980) && y > 20 && y < 80) return [x + offset, y] as const;
      return [x, y] as const;
    });
    return `${points.map(([x, y], index) => `${index === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ")} Z`;
  });
}

function createLeaderArcs(seed: number, count = 12) {
  const edges = ["top", "right", "bottom", "left"] as const;
  return Array.from({ length: count }, (_, index) => {
    const salt = index * 13;
    const edge = edges[Math.floor(randomUnit(seed, salt + 1) * edges.length)];
    const horizontal = edge === "top" || edge === "bottom";
    const maximum = horizontal ? 1000 : 100;
    const margin = horizontal ? 18 : 16;
    const span = horizontal
      ? 110 + randomUnit(seed, salt + 2) * 190
      : 30 + randomUnit(seed, salt + 2) * 40;
    const direction = randomUnit(seed, salt + 3) > 0.5 ? 1 : -1;
    const usable = maximum - margin * 2 - span;
    const start = direction > 0
      ? margin + randomUnit(seed, salt + 4) * usable
      : margin + span + randomUnit(seed, salt + 4) * usable;
    const baseline = edge === "top" ? 8 : edge === "bottom" ? 92 : edge === "left" ? 8 : 992;
    const pointCount = 6 + Math.floor(randomUnit(seed, salt + 5) * 3);
    const points = Array.from({ length: pointCount }, (_, pointIndex) => {
      const progress = pointIndex / (pointCount - 1);
      const tangent = start + direction * span * progress;
      const jitter = pointIndex === 0 || pointIndex === pointCount - 1
        ? 0
        : (randomUnit(seed, salt + 10 + pointIndex) - 0.5) * (horizontal ? 16 : 12);
      if (horizontal) {
        const y = baseline + (edge === "bottom" ? -jitter : jitter);
        return [tangent, y] as const;
      }
      const x = baseline + (edge === "right" ? -jitter : jitter);
      return [x, tangent] as const;
    });

    const mainPath = points.map(([x, y], pointIndex) =>
      `${pointIndex === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`,
    ).join(" ");
    const branchIndex = 2 + Math.floor(randomUnit(seed, salt + 6) * (pointCount - 4));
    const [branchX, branchY] = points[branchIndex];
    const branch = horizontal
      ? `M ${branchX.toFixed(1)} ${branchY.toFixed(1)} L ${(branchX + (randomUnit(seed, salt + 7) - 0.5) * 8).toFixed(1)} ${(branchY + (edge === "top" ? 7 : -7)).toFixed(1)} L ${(branchX + 3).toFixed(1)} ${(branchY + (edge === "top" ? 12 : -12)).toFixed(1)}`
      : `M ${branchX.toFixed(1)} ${branchY.toFixed(1)} L ${(branchX + (edge === "left" ? 7 : -7)).toFixed(1)} ${(branchY + (randomUnit(seed, salt + 7) - 0.5) * 8).toFixed(1)} L ${(branchX + (edge === "left" ? 12 : -12)).toFixed(1)} ${(branchY + 3).toFixed(1)}`;
    const cycle = 1 + randomUnit(seed, salt + 8) * 0.7;

    return {
      id: index,
      glow: `${mainPath} ${branch}`,
      core: mainPath,
      cycle: `${cycle.toFixed(2)}s`,
      delay: `${(randomUnit(seed, salt + 9) * cycle).toFixed(2)}s`,
    };
  });
}

export default function Leaderboard({ rows, problems }: Props) {
  const arcSeed = useRef<number | null>(null);
  if (arcSeed.current === null) arcSeed.current = Math.random();
  const reduceMotion = useReducedMotion();
  const highestRank = rows[0]?.rank;
  const sortedProblems = [...problems].sort((a, b) => a.order - b.order);
  return (
    <div className="surface rounded-3xl h-full flex flex-col overflow-hidden">
      <div className="px-5 py-3 border-b border-white/5 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <div className="size-2 rounded-full bg-g-blue animate-pulse" />
          <h2 className="font-display font-bold text-lg tracking-wide">排行榜</h2>
        </div>
        <div className="grid w-full grid-cols-[repeat(auto-fit,minmax(56px,1fr))] gap-x-1 gap-y-1 text-[10px] text-ink-300 font-mono">
          {sortedProblems.map((p) => {
            const maxBonus = Math.max(0, ...(p.beat_bonus_tiers ?? []).map((tier) => tier.bonus_pts));
            const maxScore = p.points + maxBonus;
            const tiers = [...(p.beat_bonus_tiers ?? [])]
              .sort((a, b) => b.min_beat_pct - a.min_beat_pct)
              .map((tier) => `Beat ${tier.min_beat_pct}%+: +${tier.bonus_pts}`)
              .join("; ");
            return (
              <div
                key={p.title_slug}
                className="flex min-w-0 items-center justify-center gap-1 whitespace-nowrap"
                title={`基本分 ${p.points}，含 Beat bonus 最高 ${maxScore}${tiers ? `；${tiers}` : "（無 bonus）"}`}
                aria-label={`${p.title ?? p.title_slug}: ${p.points} base points, up to ${maxScore} points including Beat bonus${tiers ? `; ${tiers}` : "; no bonus tiers"}`}
              >
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ background: difficultyColor(p.difficulty) }}
                />
                <span>
                  {p.points}{maxBonus > 0 && <span className="text-ink-100">({maxScore})</span>}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence initial={false}>
          {rows.map((row) => {
            const isLeader = row.rank === highestRank;
            const rowSeed = arcSeed.current! + usernameSeed(row.username);
            const leaderArcs = isLeader ? createLeaderArcs(rowSeed) : [];
            const perimeterVariants = isLeader ? createPerimeterVariants(rowSeed) : [];
            const perimeterMorphValues = [...perimeterVariants, perimeterVariants[0]].join(";");
            const perimeterDuration = 4.5 + randomUnit(rowSeed, 901) * 2;
            const perimeterDelay = `${(randomUnit(rowSeed, 902) * perimeterDuration).toFixed(2)}s`;
            const perimeterTimingStyle = isLeader
              ? ({
                  "--perimeter-duration": `${perimeterDuration.toFixed(2)}s`,
                  "--perimeter-delay": `${(randomUnit(rowSeed, 903) * perimeterDuration).toFixed(2)}s`,
                } as CSSProperties)
              : undefined;
            return (
              <motion.div
                key={row.username}
                layout
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 12 }}
                transition={{ type: "spring", stiffness: 120, damping: 20 }}
                className={`px-3 py-2 border-b border-white/5 ${isLeader ? "leaderboard-leader-row" : ""}`}
                style={perimeterTimingStyle}
              >
                <Row row={row} problems={sortedProblems} />
                {isLeader && (
                  <svg
                    className="leaderboard-row-electric"
                    viewBox="0 0 1000 100"
                    preserveAspectRatio="none"
                    aria-hidden="true"
                  >
                    <g>
                      <path
                        className="leader-permanent-glow"
                        d={perimeterVariants[0]}
                        vectorEffect="non-scaling-stroke"
                      >
                        {!reduceMotion && (
                          <animate
                            attributeName="d"
                            values={perimeterMorphValues}
                            keyTimes="0;0.2;0.4;0.6;0.8;1"
                            keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1"
                            calcMode="spline"
                            begin={perimeterDelay}
                            dur={`${perimeterDuration.toFixed(2)}s`}
                            repeatCount="indefinite"
                          />
                        )}
                      </path>
                      <path
                        className="leader-permanent-core"
                        d={perimeterVariants[0]}
                        vectorEffect="non-scaling-stroke"
                      >
                        {!reduceMotion && (
                          <animate
                            attributeName="d"
                            values={perimeterMorphValues}
                            keyTimes="0;0.2;0.4;0.6;0.8;1"
                            keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1"
                            calcMode="spline"
                            begin={perimeterDelay}
                            dur={`${perimeterDuration.toFixed(2)}s`}
                            repeatCount="indefinite"
                          />
                        )}
                      </path>
                      <path
                        className="leader-perimeter-current"
                        d={perimeterVariants[0]}
                        pathLength="1000"
                        vectorEffect="non-scaling-stroke"
                      >
                        {!reduceMotion && (
                          <animate
                            attributeName="d"
                            values={perimeterMorphValues}
                            keyTimes="0;0.2;0.4;0.6;0.8;1"
                            keySplines="0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1;0.42 0 0.58 1"
                            calcMode="spline"
                            begin={perimeterDelay}
                            dur={`${perimeterDuration.toFixed(2)}s`}
                            repeatCount="indefinite"
                          />
                        )}
                      </path>
                    </g>
                    {leaderArcs.map((arc) => (
                      <g
                        key={arc.id}
                        className="leader-electric-arc"
                        onAnimationIteration={(event) => {
                          const nextArc = createLeaderArcs(Math.random(), 1)[0];
                          event.currentTarget
                            .querySelector(".leader-electric-glow")
                            ?.setAttribute("d", nextArc.glow);
                          event.currentTarget
                            .querySelector(".leader-electric-core")
                            ?.setAttribute("d", nextArc.core);
                        }}
                        style={{
                          "--arc-cycle": arc.cycle,
                          "--arc-delay": arc.delay,
                        } as CSSProperties}
                      >
                        <path
                          className="leader-electric-glow"
                          d={arc.glow}
                          vectorEffect="non-scaling-stroke"
                        />
                        <path
                          className="leader-electric-core"
                          d={arc.core}
                          vectorEffect="non-scaling-stroke"
                        />
                      </g>
                    ))}
                  </svg>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
        {rows.length === 0 && (
          <div className="p-8 text-center text-ink-300 text-sm">尚未有參賽者</div>
        )}
      </div>
    </div>
  );
}

function Row({ row, problems }: { row: LeaderboardRow; problems: ProblemPayload[] }) {
  const colour = userColor(row.username, row.color);

  return (
    <div className="flex items-center gap-3">
      <div className="text-xl font-black text-ink-300 font-mono w-8 shrink-0 text-right tabular">
        {row.rank}
      </div>
      <div
        className="relative size-11 rounded-full overflow-hidden flex-shrink-0"
        style={{ boxShadow: `0 0 0 2px ${colour}, 0 0 0 4px rgba(0,0,0,0.4)` }}
      >
        {row.avatar_url ? (
          <img src={row.avatar_url} alt="" className="size-full object-cover" />
        ) : (
          <div
            className="size-full flex items-center justify-center text-stage-900 font-black"
            style={{ background: colour }}
          >
            {row.username.slice(0, 1).toUpperCase()}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div
          className="text-[14px] font-bold leading-tight whitespace-normal [overflow-wrap:anywhere]"
          style={{ color: colour }}
        >
          {row.username}
        </div>
        <div className="text-[11px] text-ink-300 font-mono truncate">{row.student_id}</div>
      </div>
      <div className="flex w-[88px] shrink-0 flex-wrap content-center justify-start gap-1">
        {problems.map((p) => {
          const solved = row.solved_problems.includes(p.title_slug);
          return (
            <div
              key={p.title_slug}
              className="size-3.5 shrink-0 rounded-sm border-2"
              style={{
                borderColor: difficultyColor(p.difficulty),
                background: solved ? difficultyColor(p.difficulty) : "transparent",
              }}
              title={p.title_slug}
            />
          );
        })}
      </div>
      <motion.div
        className="text-2xl font-black tabular w-12 shrink-0 text-right"
        key={row.score}
        initial={{ scale: 1.4, color: "#FBBC04" }}
        animate={{ scale: 1, color: "#f4f6ff" }}
        transition={{ duration: 0.5 }}
      >
        {row.score}
      </motion.div>
    </div>
  );
}
