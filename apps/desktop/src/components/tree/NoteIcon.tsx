import {
  Anchor,
  Archive,
  BadgeCheck,
  Ban,
  Beaker,
  Bell,
  BookMarked,
  BookOpen,
  Bookmark,
  Box,
  Braces,
  Brain,
  Briefcase,
  Bug,
  Calendar,
  CalendarClock,
  Camera,
  Car,
  ChartColumn,
  CircleAlert,
  CircleCheck,
  CircleDot,
  CircleQuestionMark,
  CircleX,
  ClipboardList,
  Clock,
  Cloud,
  Code,
  Coffee,
  Coins,
  Compass,
  Cpu,
  Crown,
  Database,
  Drama,
  Dumbbell,
  Eye,
  Feather,
  File,
  FileCode,
  FileImage,
  FileStack,
  FileText,
  Film,
  Flag,
  Flame,
  Flower2,
  Folder,
  FolderKanban,
  FolderOpen,
  FolderTree,
  Gamepad2,
  Gem,
  Gift,
  GitBranch,
  Globe,
  Goal,
  GraduationCap,
  Hammer,
  HandHeart,
  Hash,
  Headphones,
  Heart,
  HeartHandshake,
  House,
  Inbox,
  Info,
  Key,
  Keyboard,
  Landmark,
  Laptop,
  Layers,
  Leaf,
  Library,
  Lightbulb,
  Link,
  ListChecks,
  ListTodo,
  Lock,
  LockOpen,
  Mail,
  Map,
  MapPin,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Milestone,
  Monitor,
  Moon,
  Mountain,
  Music,
  Network,
  Newspaper,
  Notebook,
  Package,
  Paintbrush,
  Palette,
  Paperclip,
  PenTool,
  Pencil,
  PersonStanding,
  Phone,
  Pin,
  Plane,
  Plug,
  Presentation,
  Puzzle,
  Rocket,
  ScrollText,
  Send,
  Server,
  ShieldCheck,
  ShoppingCart,
  Smartphone,
  Smile,
  Snowflake,
  Sparkles,
  Sprout,
  Star,
  StickyNote,
  Sun,
  Table,
  Tag,
  Target,
  Telescope,
  Terminal,
  Timer,
  TreePine,
  TrendingUp,
  TriangleAlert,
  Trophy,
  User,
  UserPlus,
  Users,
  Utensils,
  Wallet,
  WandSparkles,
  Wrench,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface IconDef {
  name: string;
  icon: LucideIcon;
  keywords: string;
}

export interface IconGroup {
  id: string;
  label: string;
  icons: readonly IconDef[];
}

function def(name: string, icon: LucideIcon, keywords: string): IconDef {
  return { name, icon, keywords };
}

/** Каталог иконок, сгруппированный по смыслам — источник для пикера и поиска. */
export const ICON_GROUPS: readonly IconGroup[] = [
  {
    id: 'general',
    label: 'Общее',
    icons: [
      def('FileText', FileText, 'заметка документ текст файл'),
      def('StickyNote', StickyNote, 'стикер записка листок'),
      def('Notebook', Notebook, 'блокнот тетрадь дневник'),
      def('BookOpen', BookOpen, 'книга чтение статья'),
      def('BookMarked', BookMarked, 'учебник справочник закладка'),
      def('Bookmark', Bookmark, 'закладка сохранить'),
      def('Star', Star, 'звезда избранное важное'),
      def('Heart', Heart, 'сердце любимое'),
      def('Flag', Flag, 'флаг метка приоритет'),
      def('Pin', Pin, 'булавка закреплено'),
      def('Tag', Tag, 'тег ярлык метка'),
      def('Hash', Hash, 'хэштег решётка номер'),
      def('Pencil', Pencil, 'карандаш правка черновик'),
      def('Paperclip', Paperclip, 'скрепка вложение'),
      def('Bell', Bell, 'колокольчик напоминание уведомление'),
      def('Gem', Gem, 'кристалл ценное сокровище'),
    ],
  },
  {
    id: 'work',
    label: 'Работа и планы',
    icons: [
      def('Briefcase', Briefcase, 'портфель работа бизнес'),
      def('Target', Target, 'цель мишень фокус'),
      def('Calendar', Calendar, 'календарь дата'),
      def('CalendarClock', CalendarClock, 'срок дедлайн расписание'),
      def('Clock', Clock, 'часы время'),
      def('Timer', Timer, 'таймер секундомер помодоро'),
      def('ListTodo', ListTodo, 'список задачи туду'),
      def('ListChecks', ListChecks, 'чеклист выполнение пункты'),
      def('ClipboardList', ClipboardList, 'планшет отчёт опись'),
      def('Presentation', Presentation, 'презентация доклад доска'),
      def('Mail', Mail, 'почта письмо'),
      def('Phone', Phone, 'телефон звонок'),
      def('TrendingUp', TrendingUp, 'рост тренд прогресс'),
      def('ChartColumn', ChartColumn, 'график диаграмма статистика'),
      def('Landmark', Landmark, 'банк право учреждение'),
      def('Trophy', Trophy, 'кубок победа награда'),
    ],
  },
  {
    id: 'ideas',
    label: 'Идеи и творчество',
    icons: [
      def('Lightbulb', Lightbulb, 'идея лампочка озарение'),
      def('Brain', Brain, 'мозг мышление память'),
      def('Sparkles', Sparkles, 'искры магия новое'),
      def('WandSparkles', WandSparkles, 'волшебная палочка чудо'),
      def('Rocket', Rocket, 'ракета запуск старт'),
      def('Compass', Compass, 'компас направление курс'),
      def('Telescope', Telescope, 'телескоп исследование видение'),
      def('Puzzle', Puzzle, 'пазл головоломка часть'),
      def('Beaker', Beaker, 'колба эксперимент опыт'),
      def('Palette', Palette, 'палитра цвет дизайн'),
      def('Paintbrush', Paintbrush, 'кисть рисование живопись'),
      def('PenTool', PenTool, 'перо вектор графика'),
      def('Feather', Feather, 'перо лёгкость письмо'),
      def('Music', Music, 'музыка нота мелодия'),
      def('Drama', Drama, 'театр маски сцена'),
      def('Camera', Camera, 'камера фото снимок'),
      def('Film', Film, 'фильм кино видео'),
    ],
  },
  {
    id: 'code',
    label: 'Код и техника',
    icons: [
      def('Code', Code, 'код разработка программирование'),
      def('Terminal', Terminal, 'терминал консоль команда'),
      def('Braces', Braces, 'скобки json конфиг'),
      def('Bug', Bug, 'баг ошибка жук'),
      def('GitBranch', GitBranch, 'гит ветка версии'),
      def('Database', Database, 'база данных хранилище'),
      def('Server', Server, 'сервер бэкенд хостинг'),
      def('Cloud', Cloud, 'облако синхронизация'),
      def('Cpu', Cpu, 'процессор чип железо'),
      def('Monitor', Monitor, 'монитор экран дисплей'),
      def('Laptop', Laptop, 'ноутбук компьютер'),
      def('Smartphone', Smartphone, 'смартфон мобильный'),
      def('Keyboard', Keyboard, 'клавиатура ввод'),
      def('Wrench', Wrench, 'ключ настройка ремонт'),
      def('Hammer', Hammer, 'молоток сборка инструмент'),
      def('Plug', Plug, 'розетка плагин подключение'),
    ],
  },
  {
    id: 'people',
    label: 'Люди и общение',
    icons: [
      def('User', User, 'человек профиль персона'),
      def('Users', Users, 'люди команда группа'),
      def('UserPlus', UserPlus, 'контакт знакомство добавить'),
      def('MessageCircle', MessageCircle, 'сообщение чат разговор'),
      def('MessagesSquare', MessagesSquare, 'переписка диалог обсуждение'),
      def('Send', Send, 'отправить сообщение самолётик'),
      def('Megaphone', Megaphone, 'рупор анонс объявление'),
      def('Smile', Smile, 'улыбка эмоция настроение'),
      def('HeartHandshake', HeartHandshake, 'дружба сделка доверие'),
      def('HandHeart', HandHeart, 'забота помощь благодарность'),
      def('PersonStanding', PersonStanding, 'человек тело здоровье'),
      def('Crown', Crown, 'корона лидер главный'),
      def('GraduationCap', GraduationCap, 'учёба образование диплом'),
    ],
  },
  {
    id: 'files',
    label: 'Файлы и данные',
    icons: [
      def('Folder', Folder, 'папка каталог'),
      def('FolderOpen', FolderOpen, 'открытая папка'),
      def('FolderTree', FolderTree, 'структура дерево иерархия'),
      def('FolderKanban', FolderKanban, 'проекты канбан доска'),
      def('Archive', Archive, 'архив коробка хранение'),
      def('Box', Box, 'коробка объект куб'),
      def('Package', Package, 'пакет посылка модуль'),
      def('Inbox', Inbox, 'входящие лоток'),
      def('Layers', Layers, 'слои уровни стек'),
      def('Library', Library, 'библиотека коллекция'),
      def('FileCode', FileCode, 'файл кода скрипт'),
      def('FileImage', FileImage, 'картинка изображение'),
      def('FileStack', FileStack, 'стопка файлов копии'),
      def('Table', Table, 'таблица данные'),
      def('Newspaper', Newspaper, 'газета новости пресса'),
      def('ScrollText', ScrollText, 'свиток протокол история'),
      def('Link', Link, 'ссылка связь url'),
      def('Network', Network, 'сеть граф связи'),
    ],
  },
  {
    id: 'status',
    label: 'Статусы и знаки',
    icons: [
      def('CircleCheck', CircleCheck, 'готово выполнено галочка'),
      def('BadgeCheck', BadgeCheck, 'проверено подтверждено значок'),
      def('CircleX', CircleX, 'отменено отказ крест'),
      def('CircleAlert', CircleAlert, 'внимание важно восклицание'),
      def('TriangleAlert', TriangleAlert, 'предупреждение опасность риск'),
      def('CircleQuestionMark', CircleQuestionMark, 'вопрос неясно уточнить'),
      def('Info', Info, 'информация справка'),
      def('CircleDot', CircleDot, 'в работе точка запись'),
      def('Ban', Ban, 'запрет нельзя блок'),
      def('ShieldCheck', ShieldCheck, 'защита безопасность'),
      def('Lock', Lock, 'замок закрыто секрет'),
      def('LockOpen', LockOpen, 'открыто доступ'),
      def('Key', Key, 'ключ пароль доступ'),
      def('Eye', Eye, 'глаз наблюдение обзор'),
      def('Goal', Goal, 'цель финиш флажок'),
      def('Milestone', Milestone, 'веха этап указатель'),
    ],
  },
  {
    id: 'life',
    label: 'Мир и быт',
    icons: [
      def('Sun', Sun, 'солнце день лето'),
      def('Moon', Moon, 'луна ночь сон'),
      def('Zap', Zap, 'молния энергия быстро'),
      def('Flame', Flame, 'огонь горячее серия'),
      def('Snowflake', Snowflake, 'снежинка холод зима'),
      def('Leaf', Leaf, 'лист природа экология'),
      def('Sprout', Sprout, 'росток рост начало'),
      def('TreePine', TreePine, 'ёлка лес природа'),
      def('Flower2', Flower2, 'цветок весна'),
      def('Mountain', Mountain, 'гора вершина поход'),
      def('Globe', Globe, 'глобус мир интернет'),
      def('Map', Map, 'карта маршрут местность'),
      def('MapPin', MapPin, 'метка место адрес'),
      def('Anchor', Anchor, 'якорь море опора'),
      def('Plane', Plane, 'самолёт путешествие поездка'),
      def('Car', Car, 'машина авто дорога'),
      def('House', House, 'дом жильё быт'),
      def('Coffee', Coffee, 'кофе перерыв утро'),
      def('Utensils', Utensils, 'еда ресторан рецепт'),
      def('Gift', Gift, 'подарок праздник сюрприз'),
      def('ShoppingCart', ShoppingCart, 'покупки корзина магазин'),
      def('Wallet', Wallet, 'кошелёк деньги бюджет'),
      def('Coins', Coins, 'монеты финансы накопления'),
      def('Dumbbell', Dumbbell, 'гантель спорт зал'),
      def('Gamepad2', Gamepad2, 'игры геймпад развлечение'),
      def('Headphones', Headphones, 'наушники подкаст музыка'),
    ],
  },
];

export const ICON_CATALOG: Record<string, LucideIcon> = Object.fromEntries([
  ['File', File] as const,
  ...ICON_GROUPS.flatMap((group) => group.icons.map((item) => [item.name, item.icon] as const)),
]);

export const ICON_KEYWORDS: Record<string, string> = Object.fromEntries(
  ICON_GROUPS.flatMap((group) => group.icons.map((item) => [item.name, item.keywords] as const)),
);

export const ICON_NAMES: readonly string[] = ICON_GROUPS.flatMap((group) =>
  group.icons.map((item) => item.name),
);

export const NOTE_COLORS = ['accent', 'ai', 'ok', 'warn', 'danger', 'text-1'] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

export interface IconColorSwatch {
  value: string;
  label: string;
}

/** Палитра цветов иконок: токены темы + подобранные под тёмный фон оттенки. */
export const ICON_PALETTE: readonly IconColorSwatch[] = [
  { value: 'accent', label: 'Ирис' },
  { value: 'ai', label: 'Мята' },
  { value: 'ok', label: 'Шалфей' },
  { value: 'warn', label: 'Янтарь' },
  { value: 'danger', label: 'Коралл' },
  { value: '#F27E93', label: 'Малина' },
  { value: '#FF96C8', label: 'Роза' },
  { value: '#E58FE5', label: 'Орхидея' },
  { value: '#C48CFF', label: 'Лаванда' },
  { value: '#9E8CFF', label: 'Фиалка' },
  { value: '#6FB9FF', label: 'Небо' },
  { value: '#54D0E0', label: 'Волна' },
  { value: '#7FD98F', label: 'Луг' },
  { value: '#C8D96F', label: 'Лайм' },
  { value: '#FFCB6B', label: 'Золото' },
  { value: '#FFB27D', label: 'Абрикос' },
  { value: '#FF9E9E', label: 'Лосось' },
  { value: '#B59E8C', label: 'Какао' },
  { value: '#EDEEF2', label: 'Снег' },
  { value: '#A9ADB8', label: 'Сталь' },
  { value: '#7E8699', label: 'Графит' },
];

export function resolveIconColor(color?: string): string | undefined {
  if (color === undefined || color.length === 0) {
    return undefined;
  }
  return color.startsWith('#') ? color : `var(--${color})`;
}

export function resolveIconComponent(name?: string): LucideIcon {
  if (name !== undefined && name in ICON_CATALOG) {
    return ICON_CATALOG[name];
  }
  return FileText;
}

export interface NoteIconProps {
  icon?: string;
  color?: string;
  size?: number;
  className?: string;
  fallback?: string;
}

export function NoteIcon({ icon, color, size = 16, className, fallback }: NoteIconProps) {
  const resolved = icon !== undefined && icon.length > 0 ? icon : fallback;
  const Icon = resolveIconComponent(resolved);
  const tint = resolveIconColor(color);
  return (
    <Icon
      size={size}
      strokeWidth={1.75}
      className={className}
      style={tint !== undefined ? { color: tint } : undefined}
      aria-hidden
    />
  );
}
