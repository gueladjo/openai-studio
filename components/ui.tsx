import React, { useEffect, useRef } from 'react';
import { ChevronDown, Loader2, Menu, PanelLeftOpen, X, type LucideIcon } from 'lucide-react';

export const cx = (
  ...parts: Array<string | false | null | undefined>
): string => parts.filter(Boolean).join(' ');

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
};

export const inputClass =
  'w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-60';

export const textareaClass = cx(inputClass, 'resize-y leading-relaxed');

type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-ink shadow-card hover:bg-accent-hover',
  secondary: 'bg-surface-3 text-ink hover:bg-line',
  outline: 'border border-line bg-surface text-ink hover:border-line-strong hover:bg-surface-2',
  ghost: 'text-ink-2 hover:bg-surface-3 hover:text-ink',
  danger: 'border border-danger/30 text-danger hover:bg-danger-soft'
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-sm'
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  iconSize?: number;
  block?: boolean;
}

export const Button: React.FC<ButtonProps> = ({
  variant = 'outline',
  size = 'md',
  icon: Icon,
  iconSize = 15,
  block = false,
  className,
  children,
  type = 'button',
  ...props
}) => (
  <button
    type={type}
    className={cx(
      'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50',
      BUTTON_VARIANTS[variant],
      BUTTON_SIZES[size],
      block && 'w-full',
      className
    )}
    {...props}
  >
    {Icon && <Icon size={iconSize} className="shrink-0" aria-hidden="true" />}
    {children}
  </button>
);

type IconButtonTone = 'default' | 'accent' | 'danger';
type IconButtonSize = 'sm' | 'md' | 'lg';

const ICON_BUTTON_SIZES: Record<IconButtonSize, string> = {
  sm: 'h-8 w-8',
  md: 'h-9 w-9',
  lg: 'h-10 w-10'
};

const ICON_BUTTON_TONES: Record<IconButtonTone, string> = {
  default: 'text-ink-2 hover:bg-surface-3 hover:text-ink',
  accent: 'text-accent hover:bg-accent-soft',
  danger: 'text-ink-3 hover:bg-danger-soft hover:text-danger'
};

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  icon: LucideIcon;
  iconSize?: number;
  size?: IconButtonSize;
  tone?: IconButtonTone;
  active?: boolean;
}

export const IconButton: React.FC<IconButtonProps> = ({
  label,
  icon: Icon,
  iconSize = 18,
  size = 'md',
  tone = 'default',
  active = false,
  className,
  title,
  type = 'button',
  ...props
}) => (
  <button
    type={type}
    aria-label={label}
    title={title ?? label}
    className={cx(
      'inline-flex shrink-0 items-center justify-center rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-40',
      ICON_BUTTON_SIZES[size],
      active ? 'bg-accent-soft text-accent' : ICON_BUTTON_TONES[tone],
      className
    )}
    {...props}
  >
    <Icon size={iconSize} aria-hidden="true" />
  </button>
);

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
}

export const Switch: React.FC<SwitchProps> = ({
  checked,
  onChange,
  label,
  disabled = false,
  id,
  className
}) => (
  <button
    type="button"
    id={id}
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={cx(
      'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50',
      checked ? 'bg-accent' : 'bg-line-strong',
      className
    )}
  >
    <span
      aria-hidden="true"
      className={cx(
        'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform',
        checked ? 'translate-x-4' : 'translate-x-0'
      )}
    />
  </button>
);

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  icon?: LucideIcon;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  capitalize?: boolean;
  className?: string;
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
  capitalize = false,
  className
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('flex flex-wrap gap-1 rounded-lg bg-surface-3 p-1', className)}
    >
      {options.map(option => {
        const selected = option.value === value;
        const Icon = option.icon;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cx(
              'inline-flex min-w-[3.25rem] flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed',
              capitalize && 'capitalize',
              selected
                ? 'bg-accent text-accent-ink shadow-card'
                : 'text-ink-2 hover:text-ink'
            )}
          >
            {Icon && <Icon size={14} aria-hidden="true" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface LevelScaleProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  className?: string;
}

/** Ordered choices rendered as equal-width steps with a marker bar, so any
    number of options fits without stretching the last one. Only the selected
    step is highlighted; the scale is a choice, not a progress meter. */
export function LevelScale<T extends string>({
  options,
  value,
  onChange,
  label,
  disabled = false,
  className
}: LevelScaleProps<T>) {
  const selectedIndex = options.findIndex(option => option.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('grid gap-1', className)}
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((option, index) => {
        const selected = index === selectedIndex;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className="group flex min-w-0 flex-col items-stretch gap-1.5 rounded-md px-0.5 pb-1 pt-1.5 transition-colors hover:bg-surface-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-not-allowed"
          >
            <span
              aria-hidden="true"
              className={cx(
                'h-1.5 rounded-full transition-colors',
                selected ? 'bg-accent' : 'bg-line-strong group-hover:bg-accent/30'
              )}
            />
            <span
              className={cx(
                'truncate text-center text-[10px] capitalize leading-4',
                selected ? 'font-semibold text-accent' : 'text-ink-3'
              )}
            >
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

export const SectionLabel: React.FC<{
  children: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  className?: string;
}> = ({ children, htmlFor, hint, className }) => {
  const Tag = htmlFor ? 'label' : 'div';
  return (
    <div className={cx('flex items-center justify-between gap-2', className)}>
      <Tag
        htmlFor={htmlFor}
        className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-3"
      >
        {children}
      </Tag>
      {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
    </div>
  );
};

export const Field: React.FC<{
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ label, children, className }) => (
  <label className={cx('block space-y-1.5', className)}>
    <span className="block text-xs font-medium text-ink-2">{label}</span>
    {children}
  </label>
);

export const Select: React.FC<React.SelectHTMLAttributes<HTMLSelectElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className="relative">
    <select
      className={cx(inputClass, 'appearance-none pr-9', className)}
      {...props}
    >
      {children}
    </select>
    <ChevronDown
      size={15}
      aria-hidden="true"
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-3"
    />
  </div>
);

type PillTone = 'neutral' | 'accent' | 'danger' | 'warn';

const PILL_TONES: Record<PillTone, string> = {
  neutral: 'bg-surface-3 text-ink-2',
  accent: 'bg-accent-soft text-accent',
  danger: 'bg-danger-soft text-danger',
  warn: 'bg-warn-soft text-warn'
};

export const Pill: React.FC<{
  tone?: PillTone;
  children: React.ReactNode;
  className?: string;
  title?: string;
}> = ({ tone = 'neutral', children, className, title }) => (
  <span
    title={title}
    className={cx(
      'inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium',
      PILL_TONES[tone],
      className
    )}
  >
    {children}
  </span>
);

type CalloutTone = 'info' | 'warn' | 'danger';

const CALLOUT_TONES: Record<CalloutTone, string> = {
  info: 'border-accent/25 bg-accent-soft text-ink',
  warn: 'border-warn/30 bg-warn-soft text-warn',
  danger: 'border-danger/30 bg-danger-soft text-danger'
};

export const Callout: React.FC<{
  tone?: CalloutTone;
  icon?: LucideIcon;
  role?: string;
  children: React.ReactNode;
  className?: string;
}> = ({ tone = 'info', icon: Icon, role, children, className }) => (
  <div
    role={role}
    className={cx(
      'flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-relaxed',
      CALLOUT_TONES[tone],
      className
    )}
  >
    {Icon && <Icon size={14} className="mt-0.5 shrink-0" aria-hidden="true" />}
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);

export const Spinner: React.FC<{ size?: number; className?: string }> = ({
  size = 16,
  className
}) => (
  <Loader2
    size={size}
    aria-hidden="true"
    className={cx('animate-spin text-accent', className)}
  />
);

/** Closes a floating element on outside pointer-down or Escape. */
export const useDismiss = (
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onDismiss: () => void
): void => {
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onDismiss, ref]);
};

type DialogSize = 'sm' | 'md' | 'lg';

const DIALOG_SIZES: Record<DialogSize, string> = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl'
};

export interface DialogProps {
  open: boolean;
  onClose?: () => void;
  title: React.ReactNode;
  titleId: string;
  description?: React.ReactNode;
  role?: 'dialog' | 'alertdialog';
  size?: DialogSize;
  tone?: 'default' | 'danger';
  icon?: LucideIcon;
  footer?: React.ReactNode;
  children?: React.ReactNode;
  /** Hide the header close control (the footer then owns dismissal). */
  hideClose?: boolean;
  bodyClassName?: string;
}

export const Dialog: React.FC<DialogProps> = ({
  open,
  onClose,
  title,
  titleId,
  description,
  role = 'dialog',
  size = 'md',
  tone = 'default',
  icon: Icon,
  footer,
  children,
  hideClose = false,
  bodyClassName
}) => {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && onClose) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end justify-center bg-overlay animate-fade-in sm:items-center sm:p-4"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx(
          'flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-pop outline-none animate-pop-in sm:rounded-2xl',
          DIALOG_SIZES[size]
        )}
      >
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          {Icon && (
            <span
              className={cx(
                'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-accent-soft text-accent'
              )}
            >
              <Icon size={17} aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold tracking-tight text-ink">
              {title}
            </h2>
            {description && (
              <p className="mt-1 text-sm leading-relaxed text-ink-2">{description}</p>
            )}
          </div>
          {onClose && !hideClose && (
            <IconButton label="Close" icon={X} size="sm" onClick={onClose} className="-mr-1 -mt-1" />
          )}
        </div>
        {children && (
          <div className={cx('min-h-0 flex-1 overflow-y-auto px-5 pb-5', bodyClassName)}>
            {children}
          </div>
        )}
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface-2 px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};

/** Brand mark used in the sidebar, title bar, and empty states. */
export const BrandMark: React.FC<{ size?: number; className?: string }> = ({
  size = 24,
  className
}) => (
  <span
    aria-hidden="true"
    className={cx(
      'inline-flex shrink-0 items-center justify-center rounded-lg bg-accent text-accent-ink',
      className
    )}
    style={{ width: size, height: size }}
  >
    <svg
      viewBox="0 0 24 24"
      width={size * 0.6}
      height={size * 0.6}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 12a8 8 0 0 1 8-8" />
      <path d="M20 12a8 8 0 0 1-8 8" />
      <circle cx="12" cy="12" r="2.5" />
    </svg>
  </span>
);

/** Top bar shared by the chat, project, and welcome views. */
export const ViewHeader: React.FC<{
  children: React.ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <div
    className={cx(
      'flex min-h-14 shrink-0 items-center gap-1.5 border-b border-line bg-surface/90 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-sm sm:px-3',
      className
    )}
  >
    {children}
  </div>
);

/** Sidebar affordances for a view header: the mobile drawer opener and the
    desktop "show sidebar" control that appears while the sidebar is hidden. */
export const SidebarControls: React.FC<{
  onOpenSidebar?: () => void;
  onToggleSidebar?: () => void;
  isSidebarCollapsed?: boolean;
}> = ({ onOpenSidebar, onToggleSidebar, isSidebarCollapsed = false }) => (
  <>
    {onOpenSidebar && (
      <IconButton label="Open menu" icon={Menu} className="md:hidden" onClick={onOpenSidebar} />
    )}
    {onToggleSidebar && isSidebarCollapsed && (
      <IconButton
        label="Show sidebar"
        icon={PanelLeftOpen}
        className="hidden md:inline-flex"
        onClick={onToggleSidebar}
      />
    )}
  </>
);
