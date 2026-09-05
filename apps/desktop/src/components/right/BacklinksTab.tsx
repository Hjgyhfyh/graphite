import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowDownLeft, Inbox, TextQuote } from 'lucide-react';
import { Tooltip, cx } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { LinkIn, NoteRef, RelType } from '@graphite/bindings';
import { wrapPlainMention } from '@graphite/editor';
import { springSnappy, usePrefersReducedMotion } from '../../motion';
import { titleFromRef } from '../../stores/tabsStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { mentionNeedle, pickUnlinkedMentions } from '../../lib/unlinkedMentions';
import type { MentionHit } from '../../lib/unlinkedMentions';
import { WELCOME_NOTE_REF } from '../editor/editorSession';
import { NoteIcon } from '../tree/NoteIcon';

export interface BacklinksTabProps {
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

export function BacklinksTab({ noteRef }: BacklinksTabProps) {
  const tree = useVaultStore((s) => s.tree);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const reduced = usePrefersReducedMotion();
  const [links, setLinks] = useState<LinkIn[]>([]);
  const [mentions, setMentions] = useState<MentionHit[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyRef, setBusyRef] = useState<NoteRef | undefined>();
  const noteTitle = useMemo(
    () => tree.find((node) => node.ref === noteRef)?.title ?? titleFromRef(noteRef),
    [tree, noteRef],
  );

  const load = useCallback(() => {
    let cancelled = false;
    setLinks([]);
    setMentions([]);
    setLoading(true);

    const needle = noteRef === WELCOME_NOTE_REF ? undefined : mentionNeedle(noteTitle);
    const linkedP = commands.linksGet({ ref: noteRef, direction: 'in' }).catch(() => ({ in: [], out: [] }));
    const searchP =
      needle === undefined
        ? Promise.resolve({ hits: [] })
        : commands.search({ query: needle, mode: 'keyword', limit: 40 }).catch(() => ({ hits: [] }));

    void Promise.all([linkedP, searchP]).then(([response, search]) => {
      if (cancelled) {
        return;
      }
      const seen = new Set<string>();
      const unique: LinkIn[] = [];
      for (const edge of response.in) {
        const key = `${edge.from}|${edge.type}`;
        if (!seen.has(key)) {
          seen.add(key);
          unique.push(edge);
        }
      }
      const linkedFrom = new Set(unique.map((edge) => edge.from));
      setLinks(unique);
      setMentions(pickUnlinkedMentions(search.hits, noteRef, linkedFrom));
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [noteRef, noteTitle]);

  useEffect(() => {
    return load();
  }, [load]);

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

  const linkMention = async (mention: MentionHit) => {
    const needle = mentionNeedle(noteTitle);
    if (needle === undefined || busyRef !== undefined) {
      return;
    }
    setBusyRef(mention.ref);
    try {
      const apply = async (rev: string, content: string): Promise<boolean> => {
        const replace = wrapPlainMention(content, needle);
        if (replace === undefined) {
          return false;
        }
        await commands.noteEdit({
          ref: mention.ref,
          rev,
          ops: [{ op: 'replace', oldString: replace.oldString, newString: replace.newString }],
        });
        return true;
      };

      const read = await commands.noteRead({ ref: mention.ref });
      let ok = false;
      try {
        ok = await apply(read.rev, read.content);
      } catch (error) {
        if (!(isGraphiteError(error) && error.code === 'CONFLICT')) {
          throw error;
        }
        const fresh = await commands.noteRead({ ref: mention.ref });
        ok = await apply(fresh.rev, fresh.content);
      }
      if (!ok) {
        useUiStore.getState().pushToast({
          kind: 'info',
          text: 'В тексте нет точного имени — откройте заметку и поставьте [[ссылку]] сами',
        });
        return;
      }
      setMentions((prev) => prev.filter((item) => item.ref !== mention.ref));
      setLinks((prev) =>
        prev.some((edge) => edge.from === mention.ref)
          ? prev
          : [{ from: mention.ref, type: 'related' }, ...prev],
      );
      useUiStore.getState().pushToast({
        kind: 'success',
        text: `Связано из «${titleOf(mention.ref)}»`,
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

  const empty = !loading && links.length === 0 && mentions.length === 0;

  return (
    <div className="flex flex-col gap-4 p-3">
      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <h3 className="flex items-center gap-1.5 text-caption text-text-2">
            <ArrowDownLeft size={13} strokeWidth={1.75} />
            Входящие ссылки
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
                const info = iconOf(link.from);
                return (
                  <motion.li
                    key={`${link.from}|${link.type}`}
                    layout={!reduced}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={springSnappy}
                  >
                    <button
                      type="button"
                      onClick={() => useVaultStore.getState().openNote(link.from)}
                      className="group flex w-full items-center gap-2 rounded-s px-2 py-1.5 text-left outline-none transition-colors duration-[120ms] hover:bg-bg-2"
                    >
                      <NoteIcon
                        icon={info.icon}
                        color={info.color}
                        size={15}
                        className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                      />
                      <span className="min-w-0 flex-1 truncate text-ui text-text-1 group-hover:text-text-0">
                        {titleOf(link.from)}
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
          <p className="px-1 text-caption text-text-3">Пока нет входящих [[ссылок]]</p>
        )}
      </section>

      {loading ? null : mentions.length > 0 ? (
        <section className="flex flex-col gap-2">
          <div className="flex items-center justify-between px-1">
            <h3 className="flex items-center gap-1.5 text-caption text-text-2">
              <TextQuote size={13} strokeWidth={1.75} />
              Упоминания без ссылки
            </h3>
            <span className="rounded-full bg-bg-3 px-1.5 text-micro text-text-2">{mentions.length}</span>
          </div>
          <ul className="flex flex-col gap-0.5">
            <AnimatePresence initial={false}>
              {mentions.map((mention) => {
                const info = iconOf(mention.ref);
                const busy = busyRef === mention.ref;
                return (
                  <motion.li
                    key={mention.ref}
                    layout={!reduced}
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: -6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={springSnappy}
                    className="group flex items-start gap-0.5 rounded-s pr-1 hover:bg-bg-2"
                  >
                    <button
                      type="button"
                      onClick={() => useVaultStore.getState().openNote(mention.ref)}
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
                          {titleOf(mention.ref)}
                        </span>
                        {mention.snippet.length > 0 ? (
                          <span className="mt-0.5 line-clamp-2 text-micro text-text-3">{mention.snippet}</span>
                        ) : null}
                      </span>
                    </button>
                    <Tooltip content="Обернуть упоминание в [[вики-ссылку]]" side="left">
                      <button
                        type="button"
                        disabled={busyRef !== undefined}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.stopPropagation();
                          void linkMention(mention);
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
      ) : null}

      {empty ? (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
          <Inbox size={18} strokeWidth={1.5} className="text-text-3" />
          <p className="max-w-[220px] text-caption text-text-2">
            На эту заметку пока никто не ссылается. Бэклинки появятся из{' '}
            <span className="font-mono text-text-1">[[вики-ссылки]]</span>, а упоминания — если имя встретится в тексте
            без скобок.
          </p>
        </div>
      ) : null}
    </div>
  );
}
