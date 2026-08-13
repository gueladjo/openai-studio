
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
  Sliders,
  Globe,
  Terminal,
  Trash2,
  ChevronDown,
  ChevronUp,
  Plus
} from 'lucide-react';

interface ConfigPanelProps {
  config: ChatConfig;
  onChange: (newConfig: ChatConfig) => void;
  systemInstructions: SystemInstruction[];
  onUpdateSystemInstruction: (instruction: SystemInstruction) => void;
  onCreateSystemInstruction: () => void;
  onDeleteSystemInstruction: (id: string) => void;
  readOnly?: boolean;
  hideSystemInstructions?: boolean;
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({
  config,
  onChange,
  systemInstructions,
  onUpdateSystemInstruction,
  onCreateSystemInstruction,
  onDeleteSystemInstruction,
  readOnly = false,
  hideSystemInstructions = false
}) => {
  const [isSystemInstructionsOpen, setIsSystemInstructionsOpen] = useState(false);
  const [isWebSearchOptionsOpen, setIsWebSearchOptionsOpen] = useState(false);
  const systemInstructionsSelectId = useId();
  const systemInstructionsOptionsId = useId();
  const webSearchOptionsId = useId();

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newModel = e.target.value as ModelId;
    const newReasoning = getNormalizedReasoningEffort(newModel, config.reasoningEffort);

    onChange({
      ...config,
      model: newModel,
      reasoningEffort: newReasoning
    });
  };

  const selectedInstruction = systemInstructions.find(si => si.id === config.systemInstructionId);
  const modelConfig = getModelConfig(config.model);
  const availableReasoningOptions = modelConfig.reasoningOptions;
  const selectedReasoningEffort = getNormalizedReasoningEffort(config.model, config.reasoningEffort);
  const supportsVerbosity = modelConfig.supportsVerbosity;
  const webSearchOptions = config.tools.webSearchOptions;
  const webSearchLocation = webSearchOptions.userLocation;

  const updateWebSearchOptions = (
    options: ChatConfig['tools']['webSearchOptions']
  ) => {
    onChange({
      ...config,
      tools: {
        ...config.tools,
        webSearchOptions: options
      }
    });
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

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-gray-50 transition-colors duration-200 md:w-80 md:flex-shrink-0 md:border-l md:border-gray-200 dark:bg-[#0d1117] md:dark:border-gray-800">
        <div className="hidden items-center gap-2 border-b border-gray-200 p-4 text-gray-700 md:flex dark:border-gray-800 dark:text-gray-200">
          <Sliders size={18} />
          <h2 className="font-semibold text-sm">Configuration</h2>
        </div>

      <fieldset
        disabled={readOnly}
        aria-label={readOnly ? 'Configuration is read-only while another tab is editing' : undefined}
        className={`min-w-0 border-0 p-6 space-y-8 ${
          readOnly ? 'pointer-events-none opacity-60' : ''
        }`}
      >
        {/* System Instructions */}
        {!hideSystemInstructions && (
          <div className="space-y-3">
            <label
              htmlFor={systemInstructionsSelectId}
              className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
            >
              System instructions
            </label>
            <div
              className={`rounded-md border transition-colors ${
                selectedInstruction
                  ? 'border-blue-200 bg-blue-50 dark:border-blue-500/50 dark:bg-blue-900/10'
                  : 'border-gray-200 bg-white dark:border-gray-800 dark:bg-[#161b22]'
              }`}
            >
              <div className="flex items-center gap-2 p-3">
                <div className="relative min-w-0 flex-1">
                  <select
                    id={systemInstructionsSelectId}
                    disabled={readOnly}
                    value={config.systemInstructionId || ''}
                    onChange={event => onChange({
                      ...config,
                      systemInstructionId: event.target.value || undefined
                    })}
                    className="w-full appearance-none rounded-md border border-gray-200 bg-white py-2 pl-2.5 pr-8 text-sm text-gray-800 outline-none transition-colors focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-[#161b22] dark:text-gray-200"
                  >
                    <option value="">None</option>
                    {systemInstructions.map(instruction => (
                      <option key={instruction.id} value={instruction.id}>
                        {instruction.title || 'Untitled instruction'}
                      </option>
                    ))}
                  </select>
                  <div className="pointer-events-none absolute right-2.5 top-2.5 text-gray-400">
                    <ChevronDown size={14} />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={readOnly}
                  aria-expanded={isSystemInstructionsOpen}
                  aria-controls={systemInstructionsOptionsId}
                  aria-label={isSystemInstructionsOpen
                    ? 'Collapse System instructions options'
                    : 'Expand System instructions options'}
                  onClick={() => setIsSystemInstructionsOpen(open => !open)}
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded text-gray-400 transition-colors hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-gray-200"
                >
                  {isSystemInstructionsOpen
                    ? <ChevronUp size={16} />
                    : <ChevronDown size={16} />}
                </button>
              </div>

              {isSystemInstructionsOpen && (
                <div
                  id={systemInstructionsOptionsId}
                  className={`space-y-4 border-t p-3 ${
                    selectedInstruction
                      ? 'border-blue-100 dark:border-blue-500/20'
                      : 'border-gray-200 dark:border-gray-800'
                  }`}
                >
                  {selectedInstruction ? (
                    <div className="space-y-4">
                      <label className="block space-y-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                        <span>Name</span>
                        <input
                          type="text"
                          disabled={readOnly}
                          value={selectedInstruction.title}
                          onChange={event => onUpdateSystemInstruction({
                            ...selectedInstruction,
                            title: event.target.value
                          })}
                          placeholder="Instruction name"
                          className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm font-medium text-gray-800 outline-none transition-colors placeholder:text-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-[#161b22] dark:text-gray-200"
                        />
                      </label>
                      <label className="block space-y-1.5 text-xs font-medium text-gray-700 dark:text-gray-300">
                        <span>Instructions</span>
                        <textarea
                          disabled={readOnly}
                          value={selectedInstruction.content}
                          onChange={event => onUpdateSystemInstruction({
                            ...selectedInstruction,
                            content: event.target.value
                          })}
                          placeholder="Optional tone and style instructions for the model"
                          className="min-h-[120px] w-full resize-y rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm font-normal text-gray-700 outline-none transition-colors placeholder:text-gray-400 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-[#161b22] dark:text-gray-300"
                        />
                      </label>
                    </div>
                  ) : (
                    <p className="text-xs leading-5 text-gray-500 dark:text-gray-400">
                      Select an instruction to edit it, or create a new one.
                    </p>
                  )}

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={readOnly}
                      onClick={onCreateSystemInstruction}
                      className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-xs font-medium text-gray-700 transition-colors hover:border-gray-300 hover:text-gray-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-gray-700 dark:bg-[#161b22] dark:text-gray-300 dark:hover:border-gray-600 dark:hover:text-white"
                    >
                      <Plus size={14} />
                      New instruction
                    </button>
                    {selectedInstruction && (
                      <button
                        type="button"
                        disabled={readOnly}
                        onClick={() => onDeleteSystemInstruction(selectedInstruction.id)}
                        className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium text-red-600 transition-colors hover:bg-red-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-red-400 dark:hover:bg-red-950/30"
                      >
                        <Trash2 size={14} />
                        Delete instruction
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
        
        {/* Model Selection */}
        <div className="space-y-3">
          <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Model</label>
          <div className="relative">
            <select
              value={config.model}
              onChange={handleModelChange}
              className="w-full bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 text-sm rounded-md p-2.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none appearance-none transition-colors"
            >
              {MODELS.map(m => (
                <option key={m.id} value={m.id}>{m.pickerName ?? m.name}</option>
              ))}
            </select>
            <div className="absolute right-3 top-3 pointer-events-none text-gray-400">
                <ChevronDown size={14} />
            </div>
          </div>
        </div>

        {/* Reasoning Effort */}
        <div className="space-y-3">
          <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center justify-between">
            Reasoning Effort
            <span className="text-[10px] bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-700">{selectedReasoningEffort}</span>
          </label>
          <div className="grid grid-cols-1 gap-1 bg-gray-200 dark:bg-[#161b22] p-1 rounded-md border border-gray-300 dark:border-gray-800">
            {availableReasoningOptions.map(option => (
                <button
                    key={option}
                    onClick={() => onChange({ ...config, reasoningEffort: option })}
                    className={`text-xs text-left px-3 py-2 rounded capitalize transition-all ${
                        selectedReasoningEffort === option 
                        ? 'bg-white dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 border border-gray-300 dark:border-blue-600/30 font-medium shadow-sm dark:shadow-none' 
                        : 'text-gray-600 dark:text-gray-400 hover:bg-gray-300 dark:hover:bg-gray-800 hover:text-gray-800 dark:hover:text-gray-200'
                    }`}
                >
                    {option}
                </button>
            ))}
          </div>
        </div>

        {/* Text Verbosity - Hidden for o3 */}
        {supportsVerbosity && (
            <div className="space-y-3 animate-in fade-in duration-300">
            <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide flex items-center justify-between">
                Text Verbosity
                <span className="text-[10px] bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-700">{config.textVerbosity}</span>
            </label>
            <div className="flex bg-gray-200 dark:bg-[#161b22] rounded-md border border-gray-300 dark:border-gray-800 p-1">
                {TEXT_VERBOSITY.map(v => (
                    <button
                        key={v}
                        onClick={() => onChange({...config, textVerbosity: v})}
                        className={`flex-1 text-xs py-1.5 rounded capitalize transition-all ${
                            config.textVerbosity === v
                            ? 'bg-white dark:bg-blue-600 text-blue-600 dark:text-white shadow-sm'
                            : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                        }`}
                    >
                        {v}
                    </button>
                ))}
            </div>
            </div>
        )}

        {/* Tools */}
        <div className="space-y-4">
          <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">Tools</label>
          
          <div
            className={`rounded-md border transition-all ${
                config.tools.webSearch 
                ? 'bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-500/50' 
                : 'bg-white dark:bg-[#161b22] border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'
            }`}
          >
            <div className="flex items-center gap-2 p-3">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className={`p-1.5 rounded ${config.tools.webSearch ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>
                    <Globe size={16} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Web Search</div>
                    <div className="text-xs text-gray-500">Access real-time data</div>
                </div>
              </div>
              <button
                type="button"
                disabled={readOnly}
                role="switch"
                aria-checked={config.tools.webSearch}
                aria-label="Enable Web Search"
                onClick={() => onChange({
                  ...config,
                  tools: {
                    ...config.tools,
                    webSearch: !config.tools.webSearch
                  }
                })}
                className={`relative h-5 w-9 shrink-0 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 ${
                  config.tools.webSearch
                    ? 'bg-blue-500'
                    : 'bg-gray-300 dark:bg-gray-700'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform ${
                    config.tools.webSearch ? 'translate-x-4' : 'translate-x-0'
                  }`}
                />
              </button>
              <button
                type="button"
                disabled={readOnly}
                aria-expanded={isWebSearchOptionsOpen}
                aria-controls={webSearchOptionsId}
                aria-label={isWebSearchOptionsOpen
                  ? 'Collapse Web Search options'
                  : 'Expand Web Search options'}
                onClick={() => setIsWebSearchOptionsOpen(open => !open)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-gray-400 transition-colors hover:text-gray-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:text-gray-200"
              >
                {isWebSearchOptionsOpen
                  ? <ChevronUp size={16} />
                  : <ChevronDown size={16} />}
              </button>
            </div>

            {isWebSearchOptionsOpen && (
              <div
                id={webSearchOptionsId}
                className="space-y-4 border-t border-blue-100 p-3 dark:border-blue-500/20"
              >
                <div className="space-y-2">
                  <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                    Search context size
                  </div>
                  <div className="grid grid-cols-3 gap-1 rounded-md bg-gray-200 p-1 dark:bg-[#161b22]">
                    {WEB_SEARCH_CONTEXT_SIZES.map(size => (
                      <button
                        key={size}
                        type="button"
                        disabled={readOnly}
                        aria-pressed={webSearchOptions.searchContextSize === size}
                        onClick={() => updateWebSearchOptions({
                          ...webSearchOptions,
                          searchContextSize: size
                        })}
                        className={`rounded px-2 py-1.5 text-xs capitalize transition-colors ${
                          webSearchOptions.searchContextSize === size
                            ? 'bg-white font-medium text-blue-600 shadow-sm dark:bg-blue-600 dark:text-white'
                            : 'text-gray-600 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-200'
                        }`}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-xs font-medium text-gray-700 dark:text-gray-300">
                      Approximate location
                    </div>
                    <button
                      type="button"
                      disabled={readOnly || webSearchLocation === null}
                      onClick={() => updateWebSearchOptions({
                        ...webSearchOptions,
                        userLocation: null
                      })}
                      className="text-xs text-gray-500 transition-colors hover:text-red-500 disabled:cursor-default disabled:opacity-50"
                    >
                      Clear location
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="col-span-2 space-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                      <span>City</span>
                      <input
                        type="text"
                        disabled={readOnly}
                        value={webSearchLocation?.city || ''}
                        maxLength={WEB_SEARCH_LOCATION_TEXT_MAX_LENGTH}
                        onChange={event => updateWebSearchLocation('city', event.target.value)}
                        placeholder="New York"
                        className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-[#161b22] dark:text-gray-200"
                      />
                    </label>
                    <label className="space-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                      <span>Region</span>
                      <input
                        type="text"
                        disabled={readOnly}
                        value={webSearchLocation?.region || ''}
                        maxLength={WEB_SEARCH_LOCATION_TEXT_MAX_LENGTH}
                        onChange={event => updateWebSearchLocation('region', event.target.value)}
                        placeholder="NY"
                        className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm text-gray-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-[#161b22] dark:text-gray-200"
                      />
                    </label>
                    <label className="space-y-1 text-[11px] text-gray-500 dark:text-gray-400">
                      <span>Country</span>
                      <input
                        type="text"
                        disabled={readOnly}
                        value={webSearchLocation?.country || ''}
                        maxLength={2}
                        autoCapitalize="characters"
                        onChange={event => updateWebSearchLocation('country', event.target.value)}
                        placeholder="US"
                        className="w-full rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm uppercase text-gray-800 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 dark:border-gray-700 dark:bg-[#161b22] dark:text-gray-200"
                      />
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div 
            onClick={() => onChange({...config, tools: {...config.tools, codeInterpreter: !config.tools.codeInterpreter}})}
            className={`flex items-center justify-between p-3 rounded-md border cursor-pointer transition-all ${
                config.tools.codeInterpreter 
                ? 'bg-purple-50 dark:bg-purple-900/10 border-purple-200 dark:border-purple-500/50' 
                : 'bg-white dark:bg-[#161b22] border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'
            }`}
          >
             <div className="flex items-center gap-3">
                <div className={`p-1.5 rounded ${config.tools.codeInterpreter ? 'bg-purple-100 dark:bg-purple-500/20 text-purple-600 dark:text-purple-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>
                    <Terminal size={16} />
                </div>
                <div>
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Code Interpreter</div>
                    <div className="text-xs text-gray-500">Run code & analyze files</div>
                </div>
             </div>
             <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${config.tools.codeInterpreter ? 'border-purple-500 bg-purple-500' : 'border-gray-400 dark:border-gray-600'}`}>
                {config.tools.codeInterpreter && <div className="w-1.5 h-1.5 bg-white rounded-full" />}
             </div>
          </div>

        </div>

      </fieldset>
    </div>
  );
};
