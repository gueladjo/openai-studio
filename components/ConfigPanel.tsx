import React, { useId, useState } from 'react';
import { ChatConfig, ModelId, SystemInstruction } from '../types';
import {
  MODELS,
  TEXT_VERBOSITY,
  WEB_SEARCH_CONTEXT_SIZES,
  WEB_SEARCH_LOCATION_TEXT_MAX_LENGTH,
  getModelConfig,
  getNormalizedReasoningEffort
} from '../constants';
import {
  ChevronDown,
  ChevronUp,
  Globe,
  Plus,
  SlidersHorizontal,
  Terminal,
  Trash2,
  X,
  type LucideIcon
} from 'lucide-react';
import {
  Button,
  Field,
  IconButton,
  SectionLabel,
  Segmented,
  Select,
  Switch,
  cx,
  inputClass,
  textareaClass
} from './ui';

interface ConfigPanelProps {
  config: ChatConfig;
  onChange: (newConfig: ChatConfig) => void;
  systemInstructions: SystemInstruction[];
  onUpdateSystemInstruction: (instruction: SystemInstruction) => void;
  onCreateSystemInstruction: () => void;
  onDeleteSystemInstruction: (id: string) => void;
  readOnly?: boolean;
  hideSystemInstructions?: boolean;
  onClose?: () => void;
}

const formatContextWindow = (tokens: number): string => (
  tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(2))}M`
    : `${Math.round(tokens / 1_000)}K`
);

const ToolCard: React.FC<{
  icon: LucideIcon;
  title: string;
  description: string;
  enabled: boolean;
  controls: React.ReactNode;
  children?: React.ReactNode;
}> = ({ icon: Icon, title, description, enabled, controls, children }) => (
  <div
    className={cx(
      'rounded-xl border transition-colors',
      enabled ? 'border-accent/40 bg-accent-soft/60' : 'border-line bg-surface'
    )}
  >
    <div className="flex items-center gap-3 p-3">
      <span
        className={cx(
          'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
          enabled ? 'bg-accent text-accent-ink' : 'bg-surface-3 text-ink-2'
        )}
      >
        <Icon size={16} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{title}</div>
        <div className="text-xs text-ink-3">{description}</div>
      </div>
      {controls}
    </div>
    {children}
  </div>
);

export const ConfigPanel: React.FC<ConfigPanelProps> = ({
  config,
  onChange,
  systemInstructions,
  onUpdateSystemInstruction,
  onCreateSystemInstruction,
  onDeleteSystemInstruction,
  readOnly = false,
  hideSystemInstructions = false,
  onClose
}) => {
  const [isSystemInstructionsOpen, setIsSystemInstructionsOpen] = useState(false);
  const [isWebSearchOptionsOpen, setIsWebSearchOptionsOpen] = useState(false);
  const systemInstructionsSelectId = useId();
  const systemInstructionsOptionsId = useId();
  const modelSelectId = useId();
  const webSearchOptionsId = useId();

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newModel = e.target.value as ModelId;
    onChange({
      ...config,
      model: newModel,
      reasoningEffort: getNormalizedReasoningEffort(newModel, config.reasoningEffort)
    });
  };

  const selectedInstruction = systemInstructions.find(si => si.id === config.systemInstructionId);
  const modelConfig = getModelConfig(config.model);
  const selectedReasoningEffort = getNormalizedReasoningEffort(config.model, config.reasoningEffort);
  const webSearchOptions = config.tools.webSearchOptions;
  const webSearchLocation = webSearchOptions.userLocation;

  const updateTools = (tools: Partial<ChatConfig['tools']>) => {
    onChange({ ...config, tools: { ...config.tools, ...tools } });
  };

  const updateWebSearchOptions = (options: ChatConfig['tools']['webSearchOptions']) => {
    updateTools({ webSearchOptions: options });
  };

  const updateWebSearchLocation = (
    field: 'city' | 'region' | 'country',
    rawValue: string
  ) => {
    const value = field === 'country'
      ? rawValue.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2)
      : rawValue.slice(0, WEB_SEARCH_LOCATION_TEXT_MAX_LENGTH);
    updateWebSearchOptions({
      ...webSearchOptions,
      userLocation: {
        type: 'approximate',
        ...(webSearchLocation || {}),
        [field]: value
      }
    });
  };

  const body = (
    <fieldset
      disabled={readOnly}
      aria-label={readOnly ? 'Configuration is read-only while another tab is editing' : undefined}
      className={cx(
        'm-0 min-w-0 space-y-7 border-0 p-0',
        readOnly && 'pointer-events-none opacity-60'
      )}
    >
      {!hideSystemInstructions && (
        <section className="space-y-2.5">
          <SectionLabel htmlFor={systemInstructionsSelectId}>System instructions</SectionLabel>
          <div
            className={cx(
              'rounded-xl border transition-colors',
              selectedInstruction ? 'border-accent/40 bg-accent-soft/60' : 'border-line bg-surface'
            )}
          >
            <div className="flex items-center gap-1.5 p-2">
              <div className="min-w-0 flex-1">
                <Select
                  id={systemInstructionsSelectId}
                  disabled={readOnly}
                  value={config.systemInstructionId || ''}
                  onChange={event => onChange({
                    ...config,
                    systemInstructionId: event.target.value || undefined
                  })}
                >
                  <option value="">None</option>
                  {systemInstructions.map(instruction => (
                    <option key={instruction.id} value={instruction.id}>
                      {instruction.title || 'Untitled instruction'}
                    </option>
                  ))}
                </Select>
              </div>
              <IconButton
                disabled={readOnly}
                aria-expanded={isSystemInstructionsOpen}
                aria-controls={systemInstructionsOptionsId}
                label={isSystemInstructionsOpen
                  ? 'Collapse System instructions options'
                  : 'Expand System instructions options'}
                icon={isSystemInstructionsOpen ? ChevronUp : ChevronDown}
                iconSize={16}
                onClick={() => setIsSystemInstructionsOpen(open => !open)}
              />
            </div>

            {isSystemInstructionsOpen && (
              <div
                id={systemInstructionsOptionsId}
                className="space-y-4 border-t border-line/70 p-3"
              >
                {selectedInstruction ? (
                  <div className="space-y-3">
                    <Field label="Name">
                      <input
                        type="text"
                        disabled={readOnly}
                        value={selectedInstruction.title}
                        onChange={event => onUpdateSystemInstruction({
                          ...selectedInstruction,
                          title: event.target.value
                        })}
                        placeholder="Instruction name"
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Instructions">
                      <textarea
                        disabled={readOnly}
                        value={selectedInstruction.content}
                        onChange={event => onUpdateSystemInstruction({
                          ...selectedInstruction,
                          content: event.target.value
                        })}
                        placeholder="Optional tone and style instructions for the model"
                        className={cx(textareaClass, 'min-h-[120px]')}
                      />
                    </Field>
                  </div>
                ) : (
                  <p className="text-xs leading-5 text-ink-2">
                    Select an instruction to edit it, or create a new one.
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Button
                    size="sm"
                    icon={Plus}
                    disabled={readOnly}
                    onClick={onCreateSystemInstruction}
                  >
                    New instruction
                  </Button>
                  {selectedInstruction && (
                    <Button
                      size="sm"
                      variant="danger"
                      icon={Trash2}
                      disabled={readOnly}
                      onClick={() => onDeleteSystemInstruction(selectedInstruction.id)}
                    >
                      Delete instruction
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="space-y-2.5">
        <SectionLabel htmlFor={modelSelectId}>Model</SectionLabel>
        <Select id={modelSelectId} value={config.model} onChange={handleModelChange} disabled={readOnly}>
          {MODELS.map(m => (
            <option key={m.id} value={m.id}>{m.name}</option>
          ))}
        </Select>
        <p className="text-[11px] text-ink-3">
          {formatContextWindow(modelConfig.contextWindowTokens)} token context · knowledge to {modelConfig.knowledgeCutoff}
        </p>
      </section>

      <section className="space-y-2.5">
        <SectionLabel hint={<span className="capitalize">{selectedReasoningEffort}</span>}>
          Reasoning effort
        </SectionLabel>
        <Segmented
          label="Reasoning effort"
          capitalize
          disabled={readOnly}
          value={selectedReasoningEffort}
          options={modelConfig.reasoningOptions.map(option => ({ value: option, label: option }))}
          onChange={option => onChange({ ...config, reasoningEffort: option })}
        />
      </section>

      {modelConfig.supportsVerbosity && (
        <section className="space-y-2.5 animate-fade-in">
          <SectionLabel hint={<span className="capitalize">{config.textVerbosity}</span>}>
            Text verbosity
          </SectionLabel>
          <Segmented
            label="Text verbosity"
            capitalize
            disabled={readOnly}
            value={config.textVerbosity}
            options={TEXT_VERBOSITY.map(v => ({ value: v, label: v }))}
            onChange={v => onChange({ ...config, textVerbosity: v })}
          />
        </section>
      )}

      <section className="space-y-2.5">
        <SectionLabel>Tools</SectionLabel>
        <div className="space-y-2">
          <ToolCard
            icon={Globe}
            title="Web Search"
            description="Look up current information"
            enabled={config.tools.webSearch}
            controls={(
              <>
                <Switch
                  label="Enable Web Search"
                  disabled={readOnly}
                  checked={config.tools.webSearch}
                  onChange={webSearch => updateTools({ webSearch })}
                />
                <IconButton
                  size="sm"
                  disabled={readOnly}
                  aria-expanded={isWebSearchOptionsOpen}
                  aria-controls={webSearchOptionsId}
                  label={isWebSearchOptionsOpen
                    ? 'Collapse Web Search options'
                    : 'Expand Web Search options'}
                  icon={isWebSearchOptionsOpen ? ChevronUp : ChevronDown}
                  iconSize={16}
                  onClick={() => setIsWebSearchOptionsOpen(open => !open)}
                />
              </>
            )}
          >
            {isWebSearchOptionsOpen && (
              <div
                id={webSearchOptionsId}
                className="space-y-4 border-t border-line/70 p-3"
              >
                <div className="space-y-2">
                  <div className="text-xs font-medium text-ink-2">Search context size</div>
                  <Segmented
                    label="Search context size"
                    capitalize
                    disabled={readOnly}
                    className="bg-surface-3"
                    value={webSearchOptions.searchContextSize}
                    options={WEB_SEARCH_CONTEXT_SIZES.map(size => ({ value: size, label: size }))}
                    onChange={searchContextSize => updateWebSearchOptions({
                      ...webSearchOptions,
                      searchContextSize
                    })}
                  />
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-ink-2">Approximate location</div>
                    <button
                      type="button"
                      disabled={readOnly || webSearchLocation === null}
                      onClick={() => updateWebSearchOptions({
                        ...webSearchOptions,
                        userLocation: null
                      })}
                      className="text-xs text-ink-3 transition-colors hover:text-danger disabled:cursor-default disabled:opacity-50"
                    >
                      Clear location
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="City" className="col-span-2">
                      <input
                        type="text"
                        disabled={readOnly}
                        value={webSearchLocation?.city || ''}
                        maxLength={WEB_SEARCH_LOCATION_TEXT_MAX_LENGTH}
                        onChange={event => updateWebSearchLocation('city', event.target.value)}
                        placeholder="New York"
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Region">
                      <input
                        type="text"
                        disabled={readOnly}
                        value={webSearchLocation?.region || ''}
                        maxLength={WEB_SEARCH_LOCATION_TEXT_MAX_LENGTH}
                        onChange={event => updateWebSearchLocation('region', event.target.value)}
                        placeholder="NY"
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Country">
                      <input
                        type="text"
                        disabled={readOnly}
                        value={webSearchLocation?.country || ''}
                        maxLength={2}
                        autoCapitalize="characters"
                        onChange={event => updateWebSearchLocation('country', event.target.value)}
                        placeholder="US"
                        className={cx(inputClass, 'uppercase')}
                      />
                    </Field>
                  </div>
                </div>
              </div>
            )}
          </ToolCard>

          <ToolCard
            icon={Terminal}
            title="Code Interpreter"
            description="Run code and analyze files"
            enabled={config.tools.codeInterpreter}
            controls={(
              <Switch
                label="Enable Code Interpreter"
                disabled={readOnly}
                checked={config.tools.codeInterpreter}
                onChange={codeInterpreter => updateTools({ codeInterpreter })}
              />
            )}
          />
        </div>
      </section>
    </fieldset>
  );

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-canvas">
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-ink">
          <SlidersHorizontal size={16} className="text-ink-3" aria-hidden="true" />
          Chat settings
        </div>
        {onClose && (
          <IconButton label="Close chat settings" icon={X} size="sm" onClick={onClose} className="-mr-1" />
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
        {body}
      </div>
    </div>
  );
};
