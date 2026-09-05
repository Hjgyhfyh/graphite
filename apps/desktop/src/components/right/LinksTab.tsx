import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowUpRight, Tags, Unlink } from 'lucide-react';
import { Tooltip, cx } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { LinkOut, NoteRef, RelType } from '@graphite/bindings';
import { appendCaptureToDoc, similarNotesByTags } from '@graphite/editor';
import type { SimilarByTagsHit } from '@graphite/editor';
import { springSnappy, usePrefersReducedMotion } from '../../motion';
import { titleFromRef } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { wikiLinkMarkup } from '../../lib/wikiLink';
import { WELCOME_NOTE_REF, flushPendingSaves, pendingSaveFor } from '../editor/editorSession';
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

const SIMILAR_LIMIT = 8;

function relLabel(type: RelType): string {
  return REL_LABEL[type] ?? type;
}

function sharedLabel(shared: readonly string[]): string {
  const shown = shared.slice(0, 3).map((tag) => `#${tag}`);
  const extra = shared.length - shown.length;
  if (extra > 0) {
    shown.push(`+${extra}`);
  }
  return shown.join(' · ');
}

export function LinksTab({ noteRef }: LinksTabProps) {
  const tree = useVaultStore((s) => s.tree);
  const childrenByRef = useVaultStore((s) => s.childrenByRef);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const reduced = usePrefersReducedMotion();
  const [links, setLinks] = useState<LinkOut[]>([]);
  const [similar, setSimilar] = useState<SimilarByTagsHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyRef, setBusyRef] = useState<NoteRef | undefined>();

  useEffect(() => {
    let cancelled = false;
    setLinks([]);
    setSimilar([]);
    setLoading(true);
    const linkedP = commands.linksGet({ ref: noteRef, direction: 'out' }).catch(() => ({ in: [], out: [] }));
    const tagsP = noteRef === WELCOME_NOTE_REF ? Promise.resolve([]) : commands.tagsList().catch(() => []);
    void Promise.all([linkedP, tagsP]).then(([response, tags]) => {
      if (cancelled) {
        return;
      }
      const seen = new Set<string>();
      const unique: LinkOut[] = [];
      for (const edge of response.out) {
        const key = `${edge.to}|${edge.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(edge);
        }
      }
      const exclude = new Set<string>([noteRef, ...unique.map((edge) => edge.to)]);
      setLinks(unique);
      setSimilar(similarNotesByTags(noteRef, tags, { exclude, limit: SIMILAR_LIMIT }));
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [noteRef, tree]);

  const nodeByRef = useMemo(() => {
    const map: Record<NoteRef, { title: string; icon?: string; color?: string }> = {};
    for (const node of tree) {
      map[node.ref] = { title: node.title, icon: node.icon, color: node.iconColor };
    }
    for (const nodes of Object.values(childrenByRef)) {
      for (const node of nodes) {
        map[node.ref] = { title: node.title, icon: node.icon, color: node.iconColor };
      }
    }
    return map;
  }, [tree, childrenByRef]);

  const titleOf = (ref: NoteRef): string => nodeByRef[ref]?.title ?? titleFromRef(ref);
  const iconOf = (ref: NoteRef): { icon?: string; color?: string } =>
    iconByRef[ref] ?? { icon: nodeByRef[ref]?.icon, color: nodeByRef[ref]?.color };

  const linkSimilar = async (hit: SimilarByTagsHit) => {
    if (busyRef !== undefined) {
      return;
    }
    const markup = wikiLinkMarkup(titleOf(hit.ref));
    setBusyRef(hit.ref);
    try {
      await flushPendingSaves();
      await pendingSaveFor(noteRef);
      const apply = async (rev: string, content: string): Promise<void> => {
        const next = appendCaptureToDoc(content, markup);
        await commands.noteEdit({
          ref: noteRef,
          rev,
          ops:
            content.length === 0
              ? [{ op: 'prepend', content: `${markup}\n` }]
              : [{ op: 'replace', oldString: content, newString: next }],
        });
      };
      const first = await commands.noteRead({ ref: noteRef });
      try {
        await apply(first.rev, first.content);
      } catch (error) {
        if (!(isGraphiteError(error) && error.code === 'CONFLICT')) {
          throw error;
        }
        const fresh = await commands.noteRead({ ref: noteRef });
        await apply(fresh.rev, fresh.content);
      }
      setSimilar((prev) => prev.filter((item) => item.ref !== hit.ref));
      setLinks((prev) =>
        prev.some((edge) => edge.to === hit.ref) ? prev : [{ to: hit.ref, type: 'related' }, ...prev],
      );
      useUiStore.getState().pushToast({
        kind: 'success',
        text: `Связано с «${titleOf(hit.ref)}»`,
      });
    } catch (error) {
      useUiStore.getState().pushToast({
        kind: 'error',
        text: isGraphiteError(error) ? error.message : 'Не удалось связать',
      });
    } finally {
      setBusyRef(undefined);
    }
  };

  const empty = !loading && links.length === 0 && similar.length === 0;

  return (
    <div className="flex flex-col gap-4 p-3">
      <section className="flex flex-col gap-2">
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
        ) : empty ? null : (
          <p className="px-1 text-caption text-text-3">Пока нет исходящих [[ссылок]]</p>
        )}
      </section>

      {loading || similar.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <h3 className="flex items-center gap-1.5 text-caption text-text-2">
              <Tags size={13} strokeWidth={1.75} />
              Похожие по тегам
            </h3>
            <span className="rounded-full bg-bg-3 px-1.5 text-micro text-text-2">{similar.length}</span>
          </div>
          <ul className="flex flex-col gap-0.5">
            <AnimatePresence initial={false}>
              {similar.map((hit) => {
                const info = iconOf(hit.ref);
                const busy = busyRef === hit.ref;
                return (
                  <motion.li
                    key={hit.ref}
                    layout={!reduced}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={springSnappy}
                    className="group flex items-start gap-0.5 rounded-s pr-1 hover:bg-bg-2"
                  >
                    <button
                      type="button"
                      onClick={() => useVaultStore.getState().openNote(hit.ref)}
                      className="flex min-w-0 flex-1 items-start gap-2 rounded-s px-2 py-1.5 text-left outline-none"
                    >
                      <NoteIcon
                        icon={info.icon}
                        color={info.color}
                        size={15}
                        className={cx('mt-0.5', info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0')}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-ui text-text-1 group-hover:text-text-0">
                          {titleOf(hit.ref)}
                        </span>
                        <span className="mt-0.5 block truncate text-micro text-text-3">{sharedLabel(hit.shared)}</span>
                      </span>
                    </button>
                    <Tooltip content={`Дописать ${wikiLinkMarkup(titleOf(hit.ref))} в эту заметку`} side="left">
                      <button
                        type="button"
                        disabled={busyRef !== undefined}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          void linkSimilar(hit);
                        }}
                        className="mt-1 shrink-0 rounded-xs px-1.5 py-0.5 text-micro font-medium text-accent outline-none hover:bg-accent/10 disabled:opacity-45"
                      >
                        {busy ? '…' : 'Связать'}
                      </button>
                    </Tooltip>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </section>
      )}

      {empty ? (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
          <Unlink size={18} strokeWidth={1.5} className="text-text-3" />
          <p className="max-w-[220px] text-caption text-text-2">
            Связей пока нет — добавьте <span className="font-mono text-text-1">[[ссылку]]</span> прямо в тексте заметки.
            Похожие появятся, когда у заметок будут общие теги.
          </p>
        </div>
      ) : null}
    </div>
  );
}
