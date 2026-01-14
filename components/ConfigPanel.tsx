
import React, { useState } from 'react';
import { ChatConfig, ModelId, SystemInstruction } from '../types';
import { MODELS, REASONING_EFFORT_5_2, REASONING_EFFORT_MINI_NANO, REASONING_EFFORT_O3, TEXT_VERBOSITY } from '../constants';
import { Sliders, Globe, Terminal, Trash2, Plus, ChevronDown, ChevronUp } from 'lucide-react';

interface ConfigPanelProps {
  config: ChatConfig;
  onChange: (newConfig: ChatConfig) => void;
  systemInstructions: SystemInstruction[];
  onUpdateSystemInstruction: (instruction: SystemInstruction) => void;
  onCreateSystemInstruction: () => void;
  onDeleteSystemInstruction: (id: string) => void;
}

export const ConfigPanel: React.FC<ConfigPanelProps> = ({ 
  config, 
  onChange,
  systemInstructions,
  onUpdateSystemInstruction,
  onCreateSystemInstruction,
  onDeleteSystemInstruction
}) => {
  const [isSystemInstructionsOpen, setIsSystemInstructionsOpen] = useState(true);

  const handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newModel = e.target.value as ModelId;
    let newReasoning = config.reasoningEffort;
    
    // Reset reasoning if not compatible with the new model
    if (newModel === ModelId.GPT_5_2) {
        if (!REASONING_EFFORT_5_2.includes(newReasoning as any)) newReasoning = 'medium';
    } else if (newModel === ModelId.GPT_O3) {
        if (!REASONING_EFFORT_O3.includes(newReasoning as any)) newReasoning = 'medium';
    } else {
        if (!REASONING_EFFORT_MINI_NANO.includes(newReasoning as any)) newReasoning = 'medium';
    }

    onChange({
      ...config,
      model: newModel,
      reasoningEffort: newReasoning
    });
  };

  const selectedInstruction = systemInstructions.find(si => si.id === config.systemInstructionId);

  let availableReasoningOptions: string[] = [];
  if (config.model === ModelId.GPT_5_2) {
      availableReasoningOptions = REASONING_EFFORT_5_2;
  } else if (config.model === ModelId.GPT_O3) {
      availableReasoningOptions = REASONING_EFFORT_O3;
  } else {
      availableReasoningOptions = REASONING_EFFORT_MINI_NANO;
  }

  // o3 does not support text verbosity configuration
  const supportsVerbosity = config.model !== ModelId.GPT_O3;

  return (
    <div className="w-80 bg-gray-50 dark:bg-[#0d1117] border-l border-gray-200 dark:border-gray-800 flex flex-col h-full flex-shrink-0 overflow-y-auto transition-colors duration-200">
      <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-2 text-gray-700 dark:text-gray-200">
        <Sliders size={18} />
        <h2 className="font-semibold text-sm">Configuration</h2>
      </div>

      <div className="p-6 space-y-8">

        {/* System Instructions */}
        <div className="space-y-3">
            <div 
              className="flex items-center justify-between cursor-pointer group"
              onClick={() => setIsSystemInstructionsOpen(!isSystemInstructionsOpen)}
            >
               <label className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide group-hover:text-gray-700 dark:group-hover:text-gray-200 transition-colors">System instructions</label>
               {isSystemInstructionsOpen ? <ChevronUp size={14} className="text-gray-400"/> : <ChevronDown size={14} className="text-gray-400"/>}
            </div>
            
            {isSystemInstructionsOpen && (
              <div className="space-y-3 animate-in slide-in-from-top-2 duration-200">
                 {/* Selection Dropdown */}
                 <div className="relative">
                    <select
                      value={config.systemInstructionId || ''}
                      onChange={(e) => {
                         if (e.target.value === 'new') {
                             onCreateSystemInstruction();
                         } else {
                             onChange({ ...config, systemInstructionId: e.target.value || undefined });
                         }
                      }}
                      className="w-full bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-200 text-sm rounded-md p-2.5 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none appearance-none transition-colors"
                    >
                       <option value="">None</option>
                       {systemInstructions.map(si => (
                           <option key={si.id} value={si.id}>{si.title || 'Untitled Instruction'}</option>
                       ))}
                       <option disabled>──────────</option>
                       <option value="new" className="font-medium">+ Create new instruction</option>
                    </select>
                    <div className="absolute right-3 top-3 pointer-events-none text-gray-400">
                        <ChevronDown size={14} />
                    </div>
                 </div>

                 {/* Edit Form */}
                 {selectedInstruction && (
                    <div className="bg-white dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 rounded-md p-3 space-y-3 shadow-sm">
                        <div className="flex gap-2">
                           <input 
                              type="text" 
                              value={selectedInstruction.title}
                              onChange={(e) => onUpdateSystemInstruction({...selectedInstruction, title: e.target.value})}
                              placeholder="Title"
                              className="flex-1 bg-transparent border-b border-gray-200 dark:border-gray-700 pb-1 text-sm font-medium text-gray-800 dark:text-gray-200 placeholder-gray-400 focus:border-blue-500 focus:outline-none transition-colors"
                           />
                           <button 
                              onClick={() => onDeleteSystemInstruction(selectedInstruction.id)}
                              className="text-gray-400 hover:text-red-500 p-1 rounded transition-colors"
                              title="Delete instruction"
                           >
                              <Trash2 size={14} />
                           </button>
                        </div>
                        <textarea
                           value={selectedInstruction.content}
                           onChange={(e) => onUpdateSystemInstruction({...selectedInstruction, content: e.target.value})}
                           placeholder="Optional tone and style instructions for the model"
                           className="w-full bg-transparent text-sm text-gray-600 dark:text-gray-300 placeholder-gray-400 focus:outline-none resize-none min-h-[120px]"
                        />
                    </div>
                 )}
              </div>
            )}
        </div>
        
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
                <option key={m.id} value={m.id}>{m.name}</option>
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
            <span className="text-[10px] bg-gray-200 dark:bg-gray-800 text-gray-600 dark:text-gray-400 px-1.5 py-0.5 rounded border border-gray-300 dark:border-gray-700">{config.reasoningEffort}</span>
          </label>
          <div className="grid grid-cols-1 gap-1 bg-gray-200 dark:bg-[#161b22] p-1 rounded-md border border-gray-300 dark:border-gray-800">
            {availableReasoningOptions.map(option => (
                <button
                    key={option}
                    onClick={() => onChange({ ...config, reasoningEffort: option })}
                    className={`text-xs text-left px-3 py-2 rounded capitalize transition-all ${
                        config.reasoningEffort === option 
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
                        onClick={() => onChange({...config, textVerbosity: v as any})}
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
            onClick={() => onChange({...config, tools: {...config.tools, webSearch: !config.tools.webSearch}})}
            className={`flex items-center justify-between p-3 rounded-md border cursor-pointer transition-all ${
                config.tools.webSearch 
                ? 'bg-blue-50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-500/50' 
                : 'bg-white dark:bg-[#161b22] border-gray-200 dark:border-gray-800 hover:border-gray-300 dark:hover:border-gray-700'
            }`}
          >
             <div className="flex items-center gap-3">
                <div className={`p-1.5 rounded ${config.tools.webSearch ? 'bg-blue-100 dark:bg-blue-500/20 text-blue-600 dark:text-blue-400' : 'bg-gray-100 dark:bg-gray-800 text-gray-500'}`}>
                    <Globe size={16} />
                </div>
                <div>
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-200">Web Search</div>
                    <div className="text-xs text-gray-500">Access real-time data</div>
                </div>
             </div>
             <div className={`w-4 h-4 rounded-full border flex items-center justify-center ${config.tools.webSearch ? 'border-blue-500 bg-blue-500' : 'border-gray-400 dark:border-gray-600'}`}>
                {config.tools.webSearch && <div className="w-1.5 h-1.5 bg-white rounded-full" />}
             </div>
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

      </div>
    </div>
  );
};
