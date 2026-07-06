import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Command } from 'cmdk';
import { motion } from 'motion/react';
import { ArrowLeft, CornerDownLeft, FolderOpen, LayoutTemplate, Loader } from 'lucide-react';
import { Button, Kbd } from '@graphite/ui';
import { commands, isGraphiteError } from '@graphite/bindings';
import type { TreeNode } from '@graphite/bindings';
import { splitFrontmatter } from '@graphite/editor';
import { BUILTIN_TEMPLATES, TEMPLATES_FOLDER, applyTemplate, userTemplatesFromTree } from '../../lib/noteTemplates';
import type { BuiltinTemplate } from '../../lib/noteTemplates';
import { useTemplatePickerStore } from '../../stores/templatePickerStore';
import { useUiStore } from '../../stores/uiStore';
import { useVaultStore } from '../../stores/vaultStore';
import { NoteIcon } from '../tree/NoteIcon';
import { Fade, Presence, fadeVariants, popVariants, reducedFadeVariants, usePrefersReducedMotion } from '../../motion';

type PickerStep = 'pick' | 'name';

type PickedTemplate =
  | { kind: 'builtin'; template: BuiltinTemplate }
  | { kind: 'user'; node: TreeNode };

const PREVIEW_LINES = 10;

const HEADING =
  '[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-text-2';

const ROW =
  'flex h-10 cursor-default select-none items-center gap-2.5 rounded-s px-2.5 text-ui text-text-1 data-[selected=true]:bg-bg-3 data-[selected=true]:text-text-0';

const HINT_ROW =
  'flex cursor-default select-none items-center gap-2.5 rounded-s px-2.5 py-2 text-caption text-text-2';

function foldText(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е');
}

function matches(query: string, ...fields: string[]): boolean {
  const q = foldText(query.trim());
  if (q.length === 0) {
    return true;
  }
  const hay = foldText(fields.filter((field) => field.length > 0).join(' '));
  if (hay.includes(q)) {
    return true;
  }
  let cursor = 0;
  for (let i = 0; i < hay.length && cursor < q.length; i += 1) {
    if (hay[i] === q[cursor]) {
      cursor += 1;
    }
  }
  return cursor === q.length;
}

function reason(error: unknown, fallback: string): string {
  if (isGraphiteError(error)) {
    return error.code === 'UNAVAILABLE' ? 'Ядро ещё не подключено' : error.message;
  }
  return fallback;
}

function FooterHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-micro text-text-2">
      <span className="flex items-center gap-1">
        {keys.map((key, index) => (
          <Kbd key={index}>{key}</Kbd>
        ))}
      </span>
      {label}
    </span>
  );
}

function EnterHint({ label }: { label: string }) {
  return (
    <span className="flex items-center gap-1.5 text-micro text-text-2">
      <Kbd>
        <CornerDownLeft size={11} strokeWidth={2} />
      </Kbd>
      {label}
    </span>
  );
}

export function TemplatePicker() {
  const open = useTemplatePickerStore((s) => s.open);
  const tree = useVaultStore((s) => s.tree);
  const iconByRef = useVaultStore((s) => s.iconByRef);
  const reduced = usePrefersReducedMotion();
  const [step, setStep] = useState<PickerStep>('pick');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<PickedTemplate | undefined>(undefined);
  const [name, setName] = useState('');
  const [userBody, setUserBody] = useState<string | undefined>(undefined);
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const pickInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const close = () => {
    restoreFocusRef.current = null;
    useTemplatePickerStore.getState().closePicker();
  };

  const cancel = () => {
    const previous = restoreFocusRef.current;
    restoreFocusRef.current = null;
    useTemplatePickerStore.getState().closePicker();
    if (previous !== null && previous.isConnected) {
      previous.focus();
    }
  };

  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      restoreFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      return;
    }
    setStep('pick');
    setQuery('');
    setPicked(undefined);
    setName('');
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const raf = requestAnimationFrame(() => {
      if (step === 'pick') {
        pickInputRef.current?.focus();
      } else {
        nameInputRef.current?.focus();
        nameInputRef.current?.select();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, step]);

  // Тело пользовательского шаблона подгружаем заранее — превью и мгновенный Enter.
  useEffect(() => {
    setUserBody(undefined);
    setReadFailed(false);
    if (!open || step !== 'name' || picked === undefined || picked.kind !== 'user') {
      return undefined;
    }
    let cancelled = false;
    commands.noteRead({ ref: picked.node.ref }).then(
      (response) => {
        if (!cancelled) {
          setUserBody(splitFrontmatter(response.content)?.body ?? response.content);
        }
      },
      () => {
        if (!cancelled) {
          setReadFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, step, picked]);

  const pick = (next: PickedTemplate) => {
    setPicked(next);
    setName(next.kind === 'builtin' ? next.template.title : next.node.title);
    setStep('name');
  };

  const create = async () => {
    const current = picked;
    const title = name.trim();
    if (current === undefined || busy || title.length === 0) {
      return;
    }
    setBusy(true);
    try {
      let body: string;
      if (current.kind === 'builtin') {
        body = current.template.body;
      } else if (userBody !== undefined) {
        body = userBody;
      } else {
        const response = await commands.noteRead({ ref: current.node.ref });
        body = splitFrontmatter(response.content)?.body ?? response.content;
      }
      const created = await commands.noteCreate({ title, content: applyTemplate(body, title) });
      await useVaultStore.getState().loadTree();
      void useVaultStore.getState().loadInfo();
      useVaultStore.getState().openNote(created.ref);
      close();
      useUiStore.getState().pushToast({ kind: 'success', text: 'Заметка создана из шаблона' });
    } catch (error) {
      useUiStore.getState().pushToast({ kind: 'error', text: reason(error, 'Не удалось создать заметку') });
    } finally {
      setBusy(false);
    }
  };

  const userTemplates = useMemo(() => userTemplatesFromTree(tree), [tree]);
  const trimmed = query.trim();
  const builtinMatches = BUILTIN_TEMPLATES.filter((template) => matches(query, template.title, template.hint));
  const userMatches = userTemplates.filter((node) => matches(query, node.title));
  const nothingFound = trimmed.length > 0 && builtinMatches.length === 0 && userMatches.length === 0;
  const showUserGroup = userMatches.length > 0 || (userTemplates.length === 0 && trimmed.length === 0);

  let pickedIcon: ReactNode = null;
  let pickedTitle = '';
  if (picked !== undefined) {
    if (picked.kind === 'builtin') {
      const Icon = picked.template.icon;
      pickedIcon = <Icon size={15} strokeWidth={1.75} className="shrink-0 text-text-2" />;
      pickedTitle = picked.template.title;
    } else {
      const info = iconByRef[picked.node.ref] ?? { icon: picked.node.icon, color: picked.node.iconColor };
      pickedIcon = (
        <NoteIcon
          icon={info.icon}
          color={info.color}
          size={15}
          className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
        />
      );
      pickedTitle = picked.node.title;
    }
  }

  const previewSource =
    picked === undefined ? undefined : picked.kind === 'builtin' ? picked.template.body : userBody;
  const preview = useMemo(() => {
    if (previewSource === undefined) {
      return undefined;
    }
    const lines = previewSource.replace(/\r/g, '').split('\n');
    const shown = lines.slice(0, PREVIEW_LINES).join('\n').trimEnd();
    return lines.length > PREVIEW_LINES ? `${shown}\n…` : shown;
  }, [previewSource]);

  return (
    <Presence>
      {open ? (
        <motion.div
          key="template-overlay"
          className="fixed inset-0 z-40 flex items-start justify-center bg-black/55 px-4 pt-[15vh]"
          variants={reduced ? reducedFadeVariants : fadeVariants}
          initial="initial"
          animate="animate"
          exit="exit"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              if (busy) {
                return;
              }
              if (step === 'name') {
                setStep('pick');
              } else {
                cancel();
              }
            } else if (event.key === 'Tab') {
              event.preventDefault();
            }
          }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              cancel();
            }
          }}
        >
          <motion.div
            key="template-panel"
            role="dialog"
            aria-label="Заметка из шаблона"
            className="flex max-h-[70vh] w-[520px] max-w-full flex-col overflow-hidden rounded-l border border-stroke-1 bg-bg-2 shadow-3"
            variants={reduced ? reducedFadeVariants : popVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <Fade key={step} className="flex min-h-0 flex-1 flex-col">
              {step === 'name' && picked !== undefined ? (
                <>
                  <div className="flex h-11 shrink-0 items-center gap-2 border-b border-stroke-0 px-2.5">
                    <button
                      type="button"
                      aria-label="Назад к шаблонам"
                      disabled={busy}
                      onClick={() => setStep('pick')}
                      className="flex size-7 shrink-0 items-center justify-center rounded-s text-text-2 transition-colors duration-[120ms] hover:bg-bg-3 hover:text-text-0 disabled:pointer-events-none disabled:opacity-45"
                    >
                      <ArrowLeft size={16} strokeWidth={1.75} />
                    </button>
                    <input
                      ref={nameInputRef}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          void create();
                        }
                      }}
                      placeholder="Название заметки"
                      className="h-full w-full bg-transparent text-ui text-text-0 outline-none placeholder:text-text-2"
                    />
                  </div>
                  <div className="flex min-h-0 flex-col gap-2.5 overflow-y-auto p-3.5">
                    <div className="flex items-center gap-2 text-caption text-text-2">
                      {pickedIcon}
                      <span className="truncate">Шаблон «{pickedTitle}»</span>
                    </div>
                    {preview !== undefined ? (
                      <pre className="max-h-44 overflow-hidden whitespace-pre-wrap rounded-s border border-stroke-0 bg-bg-1 p-2.5 font-mono text-micro leading-relaxed text-text-2">
                        {preview}
                      </pre>
                    ) : (
                      <div className="flex items-center gap-2 rounded-s border border-stroke-0 bg-bg-1 p-2.5 text-caption text-text-2">
                        {readFailed ? (
                          <span>Шаблон не прочитался — попробуем ещё раз при создании</span>
                        ) : (
                          <>
                            <Loader size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-text-3" />
                            <span>Читаю шаблон…</span>
                          </>
                        )}
                      </div>
                    )}
                    <p className="text-micro text-text-3">
                      {'Подстановки {{title}}, {{date}} и {{time}} заполнятся при создании'}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3.5 border-t border-stroke-0 px-3.5 py-2">
                    <EnterHint label="создать" />
                    <FooterHint keys={['Esc']} label="назад" />
                    <span className="flex-1" />
                    <Button size="sm" disabled={busy || name.trim().length === 0} onClick={() => void create()}>
                      {busy ? <Loader size={13} strokeWidth={2} className="animate-spin" /> : null}
                      Создать
                    </Button>
                  </div>
                </>
              ) : (
                <Command
                  shouldFilter={false}
                  vimBindings={false}
                  label="Выбор шаблона"
                  className="flex min-h-0 flex-1 flex-col"
                >
                  <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-stroke-0 px-3.5">
                    <LayoutTemplate size={16} strokeWidth={1.75} className="shrink-0 text-text-2" />
                    <Command.Input
                      ref={pickInputRef}
                      value={query}
                      onValueChange={setQuery}
                      placeholder="Какой шаблон?"
                      className="h-full w-full bg-transparent text-ui text-text-0 outline-none placeholder:text-text-2"
                    />
                  </div>
                  <Command.List className="min-h-0 flex-1 overflow-y-auto p-1.5">
                    {builtinMatches.length > 0 ? (
                      <Command.Group heading="Встроенные" className={HEADING}>
                        {builtinMatches.map((template) => {
                          const Icon = template.icon;
                          return (
                            <Command.Item
                              key={template.id}
                              value={`tpl-builtin-${template.id}`}
                              keywords={[template.title, template.hint]}
                              onSelect={() => pick({ kind: 'builtin', template })}
                              className={ROW}
                            >
                              <Icon size={16} strokeWidth={1.75} className="shrink-0 text-text-3" />
                              <span className="flex-1 truncate">{template.title}</span>
                              <span className="max-w-[55%] shrink-0 truncate text-micro text-text-3">
                                {template.hint}
                              </span>
                            </Command.Item>
                          );
                        })}
                      </Command.Group>
                    ) : null}

                    {showUserGroup ? (
                      <Command.Group heading={`Из папки «${TEMPLATES_FOLDER}»`} className={HEADING}>
                        {userMatches.map((node) => {
                          const info = iconByRef[node.ref] ?? { icon: node.icon, color: node.iconColor };
                          return (
                            <Command.Item
                              key={node.ref}
                              value={`tpl-user-${node.ref}`}
                              keywords={[node.title]}
                              onSelect={() => pick({ kind: 'user', node })}
                              className={ROW}
                            >
                              <NoteIcon
                                icon={info.icon}
                                color={info.color}
                                size={15}
                                className={info.color === undefined ? 'shrink-0 text-text-2' : 'shrink-0'}
                              />
                              <span className="flex-1 truncate">{node.title}</span>
                            </Command.Item>
                          );
                        })}
                        {userTemplates.length === 0 ? (
                          <Command.Item disabled value="tpl-user-empty" className={HINT_ROW}>
                            <FolderOpen size={15} strokeWidth={1.75} className="shrink-0 text-text-3" />
                            <span className="flex-1">
                              Положите .md в папку «{TEMPLATES_FOLDER}» — он появится здесь
                            </span>
                          </Command.Item>
                        ) : null}
                      </Command.Group>
                    ) : null}

                    {nothingFound ? (
                      <div className="px-3 py-8 text-center text-ui text-text-2">Ничего не найдено</div>
                    ) : null}
                  </Command.List>
                  <div className="flex shrink-0 items-center gap-3.5 border-t border-stroke-0 px-3.5 py-2">
                    <FooterHint keys={['↑', '↓']} label="выбрать" />
                    <EnterHint label="далее" />
                    <FooterHint keys={['Esc']} label="закрыть" />
                  </div>
                </Command>
              )}
            </Fade>
          </motion.div>
        </motion.div>
      ) : null}
    </Presence>
  );
}
