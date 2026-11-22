import { AnimatePresence, motion } from "framer-motion";
import type { LeaderboardRow, ProblemPayload } from "../../lib/types";
import { difficultyColor, userColor } from "../../lib/color";

interface Props {
  rows: LeaderboardRow[];
  problems: ProblemPayload[];
}

export default function Leaderboard({ rows, problems }: Props) {
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
          {rows.map((row) => (
            <motion.div
              key={row.username}
              layout
              initial={{ opacity: 0, x: -12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 12 }}
              transition={{ type: "spring", stiffness: 120, damping: 20 }}
              className="px-3 py-2 border-b border-white/5"
            >
              <Row row={row} problems={sortedProblems} />
            </motion.div>
          ))}
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
