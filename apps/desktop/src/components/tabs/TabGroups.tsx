import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, ChevronRight, Layers, MoveLeft, MoveRight, Palette, Pencil, Pin, PinOff, X } from 'lucide-react';
import { cx, springTransition } from '@graphite/ui';
import { REDUCED_CROSSFADE, usePrefersReducedMotion } from '../../motion';
import { GROUP_COLORS, buildTabStrip, sortGroupsForStrip, useTabsStore } from '../../stores/tabsStore';
import type { Tab, TabGroup } from '../../stores/tabsStore';
import { resolveIconColor } from '../tree/NoteIcon';

export type DropTarget =
  | { type: 'tab'; id: string; before: boolean }
  | { type: 'pinned'; id: string; before: boolean }
  | { type: 'group'; groupId: string }
  | { type: 'end' };

export interface DropPlan {
  orderedIds: string[];
  nextGroupId: string | undefined;
  setPinned: boolean | undefined;
}

/**
 * Планирует перестановку вкладки внутри панели: закреплённые всегда слева,
 * группы держатся единым блоком левее свободных вкладок, свободная вкладка
 * не может встать левее групп.
 */
export function planDrop(
  tabs: readonly Tab[],
  groups: readonly TabGroup[],
  paneId: string,
  draggedId: string,
  target: DropTarget,
): DropPlan | null {
  const dragged = tabs.find((tab) => tab.id === draggedId && tab.paneId === paneId);
  if (dragged === undefined) {
    return null;
  }
  const strip = buildTabStrip(tabs, groups, paneId);
  const pinnedIds = strip.pinned.map((tab) => tab.id).filter((id) => id !== draggedId);
  const sections = strip.groups.map((section) => ({
    groupId: section.group.id,
    ids: section.tabs.map((tab) => tab.id).filter((id) => id !== draggedId),
  }));
  const looseIds = strip.loose.map((tab) => tab.id).filter((id) => id !== draggedId);

  const insertAt = (list: string[], targetId: string, before: boolean): boolean => {
    const at = list.indexOf(targetId);
    if (at === -1) {
      return false;
    }
    list.splice(before ? at : at + 1, 0, draggedId);
    return true;
  };

  let nextGroupId: string | undefined;
  let setPinned: boolean | undefined;

  if (target.type === 'pinned' || (target.type === 'tab' && tabs.find((tab) => tab.id === target.id)?.pinned === true)) {
    if (target.id === draggedId) {
      return null;
    }
    if (!insertAt(pinnedIds, target.id, target.before)) {
      return null;
    }
    setPinned = dragged.pinned ? undefined : true;
  } else if (target.type === 'tab') {
    if (target.id === draggedId) {
      return null;
    }
    const hovered = tabs.find((tab) => tab.id === target.id);
    if (hovered === undefined) {
      return null;
    }
    const section = hovered.groupId === undefined ? undefined : sections.find((s) => s.groupId === hovered.groupId);
    if (section !== undefined) {
      if (!insertAt(section.ids, target.id, target.before)) {
        return null;
      }
      nextGroupId = section.groupId;
    } else if (!insertAt(looseIds, target.id, target.before)) {
      return null;
    }
    setPinned = dragged.pinned ? false : undefined;
  } else if (target.type === 'group') {
    const section = sections.find((s) => s.groupId === target.groupId);
    if (section === undefined) {
      return null;
    }
    section.ids.push(draggedId);
    nextGroupId = target.groupId;
    setPinned = dragged.pinned ? false : undefined;
  } else {
    looseIds.push(draggedId);
    setPinned = dragged.pinned ? false : undefined;
  }

  return {
    orderedIds: [...pinnedIds, ...sections.flatMap((s) => s.ids), ...looseIds],
    nextGroupId,
    setPinned,
  };
}

export type GroupDropTarget = { type: 'chip'; groupId: string; before: boolean } | { type: 'groups-end' };

/** Планирует перестановку групп драгом: закреплённые группы остаются в своём блоке слева. */
export function planGroupReorder(
  groups: readonly TabGroup[],
  draggedGroupId: string,
  target: GroupDropTarget,
): string[] | null {
  const sequence = sortGroupsForStrip(groups);
  const dragged = sequence.find((group) => group.id === draggedGroupId);
  if (dragged === undefined) {
    return null;
  }
  const rest = sequence.filter((group) => group.id !== draggedGroupId);
  let insert = rest.length;
  if (target.type === 'chip') {
    if (target.groupId === draggedGroupId) {
      return null;
    }
    const at = rest.findIndex((group) => group.id === target.groupId);
    if (at === -1) {
      return null;
    }
    insert = target.before ? at : at + 1;
  }
  const pinnedCount = rest.filter((group) => group.pinned).length;
  const min = dragged.pinned ? 0 : pinnedCount;
  const max = dragged.pinned ? pinnedCount : rest.length;
  insert = Math.max(min, Math.min(max, insert));
  rest.splice(insert, 0, dragged);
  return rest.map((group) => group.id);
}

const MENU_CONTENT =
  'z-50 min-w-52 origin-(--radix-context-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-1 shadow-3';
const MENU_ITEM =
  'flex h-8 cursor-default select-none items-center gap-2 rounded-s px-2 text-ui text-text-1 outline-none data-[highlighted]:bg-bg-3 data-[highlighted]:text-text-0 data-[disabled]:pointer-events-none data-[disabled]:opacity-40';
const MENU_SWATCH =
  'z-50 origin-(--radix-context-menu-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-2 shadow-3';
const CHIP_BASE =
  'relative flex h-7 cursor-default select-none items-center gap-1.5 rounded-s px-1.5 text-caption text-text-0';

interface ColorSwatchesProps {
  active: string;
  onPick: (color: string) => void;
}

function ColorSwatches({ active, onPick }: ColorSwatchesProps) {
  return (
    <div className="flex items-center gap-1">
      {GROUP_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`Цвет ${color}`}
          onClick={() => onPick(color)}
          className={cx(
            'size-5 rounded-full border transition-transform duration-[120ms] hover:scale-110',
            active === color ? 'border-text-0' : 'border-stroke-1',
          )}
          style={{ backgroundColor: resolveIconColor(color) }}
        />
      ))}
    </div>
  );
}

export interface GroupChipProps {
  paneId: string;
  group: TabGroup;
  count: number;
  collapsedView: boolean;
  containsActive: boolean;
  isDropTarget: boolean;
  dragging: boolean;
  insertion?: 'before' | 'after';
  autoEdit?: boolean;
  onAutoEditHandled?: () => void;
  onDragStart?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragEnd?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDragOver?: (event: ReactDragEvent<HTMLDivElement>) => void;
  onDrop?: (event: ReactDragEvent<HTMLDivElement>) => void;
}

export function GroupChip({
  paneId,
  group,
  count,
  collapsedView,
  containsActive,
  isDropTarget,
  dragging,
  insertion,
  autoEdit,
  onAutoEditHandled,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: GroupChipProps) {
  const allGroups = useTabsStore((s) => s.groups);
  const toggleCollapsed = useTabsStore((s) => s.toggleGroupCollapsed);
  const toggleGroupPinned = useTabsStore((s) => s.toggleGroupPinned);
  const moveGroup = useTabsStore((s) => s.moveGroup);
  const renameGroup = useTabsStore((s) => s.renameGroup);
  const setGroupColor = useTabsStore((s) => s.setGroupColor);
  const deleteGroup = useTabsStore((s) => s.deleteGroup);
  const closeTab = useTabsStore((s) => s.close);
  const reduced = usePrefersReducedMotion();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group.name);
  const mirrorRef = useRef<HTMLSpanElement | null>(null);
  const [inputWidth, setInputWidth] = useState(48);

  useEffect(() => {
    if (autoEdit === true) {
      setDraft(group.name);
      setEditing(true);
      onAutoEditHandled?.();
    }
  }, [autoEdit, group.name, onAutoEditHandled]);

  useLayoutEffect(() => {
    if (editing) {
      const width = mirrorRef.current?.offsetWidth ?? 40;
      setInputWidth(Math.min(176, Math.max(36, width + 12)));
    }
  }, [editing, draft]);

  const sequence = sortGroupsForStrip(allGroups);
  const seqIndex = sequence.findIndex((g) => g.id === group.id);
  const canMoveLeft = seqIndex > 0 && sequence[seqIndex - 1].pinned === group.pinned;
  const canMoveRight = seqIndex !== -1 && sequence[seqIndex + 1]?.pinned === group.pinned;

  const colorVar = resolveIconColor(group.color) ?? 'var(--text-1)';
  const tint = `color-mix(in srgb, ${colorVar} 16%, transparent)`;
  const badgeTint = `color-mix(in srgb, ${colorVar} 26%, transparent)`;
  const rings: string[] = [];
  if (containsActive) {
    rings.push(`inset 0 0 0 1px ${colorVar}`);
  }
  if (isDropTarget) {
    rings.push('0 0 0 2px var(--accent)');
  }
  const chipStyle = {
    backgroundColor: tint,
    boxShadow: rings.length > 0 ? rings.join(', ') : undefined,
    ...(count === 0 ? { borderColor: `color-mix(in srgb, ${colorVar} 45%, transparent)` } : {}),
  };

  const startEdit = () => {
    setDraft(group.name);
    setEditing(true);
  };
  const commitEdit = () => {
    const name = draft.trim();
    setEditing(false);
    if (name.length > 0 && name !== group.name) {
      renameGroup(group.id, name);
    }
  };
  const cancelEdit = () => {
    setDraft(group.name);
    setEditing(false);
  };
  const ungroup = () => {
    deleteGroup(group.id);
  };
  const closeGroupTabs = () => {
    const members = useTabsStore.getState().tabs.filter((tab) => tab.groupId === group.id && tab.paneId === paneId);
    for (const member of members) {
      closeTab(member.id);
    }
    deleteGroup(group.id);
  };

  const swapTransition = reduced ? REDUCED_CROSSFADE : springTransition('snappy');

  return (
    <motion.div
      layout={!reduced}
      className="relative flex h-7 flex-none"
      initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.9 }}
      animate={{
        opacity: dragging ? 0.45 : 1,
        scale: dragging ? 0.96 : isDropTarget ? 1.04 : 1,
      }}
      transition={swapTransition}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div
            role="group"
            aria-label={`Группа ${group.name}`}
            draggable={!editing}
            onClick={collapsedView ? () => toggleCollapsed(group.id) : undefined}
            onDoubleClick={startEdit}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragOver={onDragOver}
            onDrop={onDrop}
            style={chipStyle}
            className={cx(
              CHIP_BASE,
              collapsedView && 'hover:opacity-80',
              count === 0 && 'border border-dashed',
            )}
          >
            <button
              type="button"
              aria-label={collapsedView ? 'Развернуть группу' : 'Свернуть группу'}
              onClick={(event) => {
                event.stopPropagation();
                toggleCollapsed(group.id);
              }}
              className="flex size-4 shrink-0 items-center justify-center rounded-xs text-text-2 hover:text-text-0"
            >
              <motion.span
                className="flex"
                animate={{ rotate: collapsedView ? 0 : 90 }}
                transition={reduced ? { duration: 0 } : springTransition('snappy')}
              >
                <ChevronRight size={13} strokeWidth={1.75} />
              </motion.span>
            </button>
            <Popover.Root>
              <Popover.Trigger asChild>
                <button
                  type="button"
                  aria-label="Цвет группы"
                  onClick={(event) => event.stopPropagation()}
                  className="size-2.5 shrink-0 rounded-full ring-1 ring-inset ring-black/20 transition-transform duration-[120ms] hover:scale-125"
                  style={{ backgroundColor: colorVar }}
                />
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  side="bottom"
                  align="start"
                  sideOffset={8}
                  className="z-50 origin-(--radix-popover-content-transform-origin) animate-pop rounded-m border border-stroke-1 bg-bg-2 p-2 shadow-3"
                >
                  <ColorSwatches active={group.color} onPick={(color) => setGroupColor(group.id, color)} />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            {group.pinned ? <Pin size={10} strokeWidth={1.75} className="shrink-0 text-text-2" /> : null}

            <div className="relative flex h-5 items-center">
              <AnimatePresence mode="popLayout" initial={false}>
                {editing ? (
                  <motion.div
                    key="edit"
                    className="relative flex items-center"
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: 3 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduced ? { opacity: 0 } : { opacity: 0, y: -3 }}
                    transition={swapTransition}
                  >
                    <input
                      autoFocus
                      value={draft}
                      style={{ width: inputWidth }}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={commitEdit}
                      onClick={(event) => event.stopPropagation()}
                      onPointerDown={(event) => event.stopPropagation()}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          commitEdit();
                        } else if (event.key === 'Escape') {
                          event.preventDefault();
                          cancelEdit();
                        }
                      }}
                      className="h-5 border-none bg-transparent p-0 text-caption font-medium text-text-0 outline-none"
                    />
                    <motion.span
                      aria-hidden
                      initial={reduced ? { opacity: 0 } : { scaleX: 0 }}
                      animate={reduced ? { opacity: 1 } : { scaleX: 1 }}
                      exit={{ opacity: 0 }}
                      transition={reduced ? REDUCED_CROSSFADE : springTransition('standard')}
                      className="absolute inset-x-0 -bottom-0.5 h-px origin-left rounded-full"
                      style={{ backgroundColor: colorVar }}
                    />
                  </motion.div>
                ) : (
                  <motion.span
                    key="name"
                    initial={reduced ? { opacity: 0 } : { opacity: 0, y: -3 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={reduced ? { opacity: 0 } : { opacity: 0, y: 3 }}
                    transition={swapTransition}
                    className="max-w-40 truncate font-medium"
                  >
                    {group.name}
                  </motion.span>
                )}
              </AnimatePresence>
              <span
                ref={mirrorRef}
                aria-hidden
                className="invisible absolute left-0 top-0 whitespace-pre text-caption font-medium"
              >
                {draft.length > 0 ? draft : group.name}
              </span>
            </div>

            <span
              className="flex h-4 min-w-4 shrink-0 items-center justify-center overflow-hidden rounded-full px-1 text-micro tabular-nums text-text-1"
              style={{ backgroundColor: badgeTint }}
            >
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={count}
                  initial={reduced ? { opacity: 0 } : { opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, y: -5 }}
                  transition={swapTransition}
                >
                  {count}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={MENU_CONTENT}>
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => toggleCollapsed(group.id)}>
              {collapsedView ? (
                <ChevronDown size={15} strokeWidth={1.75} className="text-text-2" />
              ) : (
                <ChevronRight size={15} strokeWidth={1.75} className="text-text-2" />
              )}
              {collapsedView ? 'Развернуть' : 'Свернуть'}
            </ContextMenu.Item>
            <ContextMenu.Item
              className={MENU_ITEM}
              onSelect={() => {
                window.setTimeout(startEdit, 0);
              }}
            >
              <Pencil size={15} strokeWidth={1.75} className="text-text-2" />
              Переименовать
            </ContextMenu.Item>
            <ContextMenu.Sub>
              <ContextMenu.SubTrigger className={cx(MENU_ITEM, 'justify-between data-[state=open]:bg-bg-3')}>
                <span className="flex items-center gap-2">
                  <Palette size={15} strokeWidth={1.75} className="text-text-2" />
                  Цвет
                </span>
                <ChevronRight size={14} strokeWidth={1.75} className="text-text-3" />
              </ContextMenu.SubTrigger>
              <ContextMenu.Portal>
                <ContextMenu.SubContent className={MENU_SWATCH}>
                  <ColorSwatches active={group.color} onPick={(color) => setGroupColor(group.id, color)} />
                </ContextMenu.SubContent>
              </ContextMenu.Portal>
            </ContextMenu.Sub>
            <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />
            <ContextMenu.Item className={MENU_ITEM} onSelect={() => toggleGroupPinned(group.id)}>
              {group.pinned ? (
                <PinOff size={15} strokeWidth={1.75} className="text-text-2" />
              ) : (
                <Pin size={15} strokeWidth={1.75} className="text-text-2" />
              )}
              {group.pinned ? 'Открепить группу' : 'Закрепить группу'}
            </ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} disabled={!canMoveLeft} onSelect={() => moveGroup(group.id, -1)}>
              <MoveLeft size={15} strokeWidth={1.75} className="text-text-2" />
              Переместить влево
            </ContextMenu.Item>
            <ContextMenu.Item className={MENU_ITEM} disabled={!canMoveRight} onSelect={() => moveGroup(group.id, 1)}>
              <MoveRight size={15} strokeWidth={1.75} className="text-text-2" />
              Переместить вправо
            </ContextMenu.Item>
            <ContextMenu.Separator className="my-1 h-px bg-stroke-0" />
            <ContextMenu.Item className={MENU_ITEM} onSelect={ungroup}>
              <Layers size={15} strokeWidth={1.75} className="text-text-2" />
              Разгруппировать
            </ContextMenu.Item>
            <ContextMenu.Item
              className={cx(MENU_ITEM, 'text-danger data-[highlighted]:text-danger')}
              onSelect={closeGroupTabs}
            >
              <X size={15} strokeWidth={1.75} />
              Закрыть вкладки
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      {insertion !== undefined ? (
        <motion.span
          aria-hidden
          initial={{ scaleY: 0 }}
          animate={{ scaleY: 1 }}
          transition={springTransition('snappy')}
          className={cx(
            'pointer-events-none absolute inset-y-1 z-30 w-0.5 origin-center rounded-full bg-accent',
            insertion === 'before' ? '-left-1' : '-right-1',
          )}
        />
      ) : null}
    </motion.div>
  );
}
