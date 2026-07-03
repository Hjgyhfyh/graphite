import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, Unlink } from 'lucide-react';
import { cx } from '@graphite/ui';
import { commands } from '@graphite/bindings';
import type { LinkOut, NoteRef, RelType } from '@graphite/bindings';
import { springSnappy, usePrefersReducedMotion } from '../../motion';
import { titleFromRef } from '../../stores/tabsStore';
import { useVaultStore } from '../../stores/vaultStore';
import { NoteIcon } from '../tree/NoteIcon';

export interface LinksTabProps {
  noteRef: NoteRef;
}

const REL_LABEL: Record<string, string> = {
  related: 'связано',
  part_of: 'часть',
  depends_on: 'зависит',
  blocks: 'блокирует',
  contradicts: 'спорит',
  distilled_from: 'выжато',
  collected_in: 'в бандле',
};

function relLabel(type: RelType): string {
  return REL_LABEL[type] ?? type;
}

export function LinksTab({ noteRef }: LinksTabProps) {
  const tree = useVaultStore((s) => s.tree);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const reduced = usePrefersReducedMotion();
  const [links, setLinks] = useState<LinkOut[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    setLoading(true);
    commands.linksGet({ ref: noteRef, direction: 'out' }).then(
      (response) => {
        if (!cancelled) {
          const seen = new Set<string>();
          const unique: LinkOut[] = [];
          for (const edge of response.out) {
            const key = `${edge.to}|${edge.type}`;
            if (!seen.has(key)) {
              seen.add(key);
              unique.push(edge);
            }
          }
          setLinks(unique);
          setLoading(false);
        }
      },
      () => {
        if (!cancelled) {
          setLinks([]);
          setLoading(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [noteRef]);

  const nodeByRef = useMemo(() => {
    const map: Record<NoteRef, { title: string; icon?: string; color?: string }> = {};
    for (const node of tree) {
      map[node.ref] = { title: node.title, icon: node.icon, color: node.iconColor };
    }
    return map;
  }, [tree]);

  const titleOf = (ref: NoteRef): string => nodeByRef[ref]?.title ?? titleFromRef(ref);
  const iconOf = (ref: NoteRef): { icon?: string; color?: string } =>
    iconByRef[ref] ?? { icon: nodeByRef[ref]?.icon, color: nodeByRef[ref]?.color };

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between px-1">
        <h3 className="flex items-center gap-1.5 text-caption text-text-2">
          <ArrowUpRight size={13} strokeWidth={1.75} />
          Исходящие связи
        </h3>
        {links.length > 0 ? (
          <span className="rounded-full bg-bg-3 px-1.5 text-micro text-text-2">{links.length}</span>
        ) : null}
      </div>
      {loading ? (
        <div className="flex flex-col gap-1">
          {[0, 1].map((row) => (
            <div
              key={row}
              className={cx(
                'h-8 rounded-s border border-stroke-0',
                reduced
                  ? 'bg-bg-2'
                  : 'animate-shimmer bg-[length:200%_100%] bg-[image:linear-gradient(90deg,var(--bg-2),var(--bg-3),var(--bg-2))]',
              )}
            />
          ))}
        </div>
      ) : links.length > 0 ? (
        <ul className="flex flex-col gap-0.5">
          <AnimatePresence initial={false}>
            {links.map((link) => {
              const info = iconOf(link.to);
              return (
                <motion.li
                  key={`${link.to}|${link.type}`}
                  layout={!reduced}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={springSnappy}
                >
                  <button
                    type="button"
                    onClick={() => useVaultStore.getState().openNote(link.to)}
                    className="group flex w-full items-center gap-2 rounded-s px-2 py-1.5 text-left outline-none transition-colors duration-[120ms] hover:bg-bg-2"
                  >
                    <NoteIcon
                      icon={info.icon}
                      color={info.color}
                      size={15}
                      className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-ui text-text-1 group-hover:text-text-0">
                        {titleOf(link.to)}
                      </span>
                      {link.context !== undefined && link.context.length > 0 ? (
                        <span className="block truncate text-micro text-text-3">{link.context}</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 rounded-xs bg-bg-3 px-1 text-micro text-text-2">
                      {relLabel(link.type)}
                    </span>
                  </button>
                </motion.li>
              );
            })}
          </AnimatePresence>
        </ul>
      ) : (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
          <Unlink size={18} strokeWidth={1.5} className="text-text-3" />
          <p className="max-w-[220px] text-caption text-text-2">
            Связей пока нет — добавьте <span className="font-mono text-text-1">[[ссылку]]</span> прямо в тексте заметки.
          </p>
        </div>
      )}
    </div>
  );
}
