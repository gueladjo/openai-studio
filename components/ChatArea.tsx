
import React, { useRef, useEffect, useState } from 'react';
import { Message, Session, Source } from '../types';
import { Send, Bot, User, Paperclip, X, FileText, BrainCircuit, ChevronDown, ChevronRight, Globe, Clock } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

interface ChatAreaProps {
  session: Session | null;
  onSendMessage: (content: string, attachments: File[]) => void;
  isLoading: boolean;
}

const ThinkingBlock = ({ text, duration }: { text: string; duration?: number }) => {
  const [isOpen, setIsOpen] = useState(true);

  if (!text) return null;

  return (
    <div className="mb-4 bg-gray-50 dark:bg-[#161b22]/50 border border-gray-200 dark:border-gray-800 rounded-lg overflow-hidden">
        <button 
            onClick={() => setIsOpen(!isOpen)}
            className="w-full flex items-center gap-2 p-3 text-xs font-medium text-gray-500 hover:bg-gray-100 dark:hover:bg-[#161b22] transition-colors"
        >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <BrainCircuit size={14} />
            <span>Reasoning Process</span>
            {duration && (
               <span className="text-gray-400 font-normal ml-1">
                 ({(duration / 1000).toFixed(1)}s)
               </span>
            )}
        </button>
        {isOpen && (
            <div className="p-3 pt-0 text-gray-600 dark:text-gray-400 text-sm font-mono leading-relaxed border-t border-transparent whitespace-pre-wrap">
                {text}
            </div>
        )}
    </div>
  );
};

const SourcesBlock = ({ sources }: { sources: Source[] }) => {
    if (!sources || sources.length === 0) return null;

    return (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-800">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2 flex items-center gap-2">
                <Globe size={12} />
                Sources
            </div>
            <div className="flex flex-wrap gap-2">
                {sources.map((source, idx) => (
                    <a 
                        key={idx}
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-2 bg-gray-100 dark:bg-[#1f2937] hover:bg-gray-200 dark:hover:bg-[#2d3748] border border-gray-200 dark:border-gray-700 rounded-full px-3 py-1.5 transition-colors max-w-[200px]"
                    >
                        {/* Try to get favicon, fallback to globe */}
                        <img 
                            src={`https://www.google.com/s2/favicons?domain=${new URL(source.url).hostname}&sz=32`} 
                            alt="" 
                            className="w-3.5 h-3.5 opacity-70"
                            onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                            }}
                        />
                        <span className="text-xs text-gray-700 dark:text-gray-300 truncate font-medium">
                            {source.title || new URL(source.url).hostname}
                        </span>
                    </a>
                ))}
            </div>
        </div>
    );
};

export const ChatArea: React.FC<ChatAreaProps> = ({ session, onSendMessage, isLoading }) => {
  const [inputValue, setInputValue] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [session?.messages]);

  const handleSend = () => {
    if ((!inputValue.trim() && attachments.length === 0) || isLoading) return;
    onSendMessage(inputValue, attachments);
    setInputValue('');
    setAttachments([]);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setAttachments(prev => [...prev, ...Array.from(e.target.files!)]);
    }
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const removeAttachment = (index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index));
  };

  if (!session) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center bg-white dark:bg-[#0d1117] text-gray-500 dark:text-gray-500 transition-colors duration-200">
        <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-800 mb-6 flex items-center justify-center transition-colors">
             <Bot size={32} className="text-blue-600 dark:text-blue-500" />
        </div>
        <p className="text-lg font-medium text-gray-700 dark:text-gray-300">Welcome to OpenAI Studio</p>
        <p className="text-sm mt-2 text-gray-500 dark:text-gray-400">Create a new chat to get started with GPT-5 models.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-white dark:bg-[#0d1117] h-full relative transition-colors duration-200">
      {/* Header */}
      <div className="h-14 border-b border-gray-200 dark:border-gray-800 flex items-center px-6 justify-between flex-shrink-0 bg-white/80 dark:bg-[#0d1117]/80 backdrop-blur-sm sticky top-0 z-10 transition-colors">
        <h2 className="font-semibold text-gray-800 dark:text-gray-200 select-text">{session.title || 'Untitled Chat'}</h2>
        <div className="text-xs text-gray-500 font-mono">
            {session.config.model} • {session.config.reasoningEffort} effort
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6 space-y-8 scroll-smooth">
        {session.messages.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-600 opacity-50">
            <Bot size={48} className="mb-4" />
            <p>Start a conversation...</p>
          </div>
        ) : (
          session.messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex gap-4 max-w-4xl mx-auto ${
                msg.role === 'user' ? 'justify-end' : 'justify-start'
              }`}
            >
              {msg.role === 'assistant' && (
                <div className="w-8 h-8 rounded-full bg-blue-600 flex-shrink-0 flex items-center justify-center mt-1 text-white shadow-sm">
                  <Bot size={16} />
                </div>
              )}

              <div className={`flex flex-col max-w-[85%] ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                  
                  {/* Attachments Section */}
                  {msg.attachments && msg.attachments.length > 0 && (
                      <div className={`flex flex-col gap-2 mb-2 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
                          {/* Images Grid */}
                          <div className={`flex flex-wrap gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                              {msg.attachments.filter(a => a.type.startsWith('image/') && a.content).map((file, i) => (
                                  <img 
                                    key={`img-${i}`} 
                                    src={file.content} 
                                    alt={file.name} 
                                    className="max-w-[240px] max-h-[240px] rounded-xl border border-gray-200 dark:border-gray-700 object-cover shadow-sm bg-gray-100 dark:bg-gray-800" 
                                  />
                              ))}
                          </div>
                          
                          {/* File Chips */}
                          <div className={`flex flex-wrap gap-2 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                              {msg.attachments.filter(a => !a.type.startsWith('image/')).map((file, i) => (
                                  <div key={`file-${i}`} className="flex items-center gap-2 bg-gray-100 dark:bg-gray-800 rounded px-3 py-1.5 text-xs text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700">
                                      <FileText size={12} />
                                      <span>{file.name}</span>
                                  </div>
                              ))}
                          </div>
                      </div>
                  )}

                  <div className={`w-full ${msg.role === 'user' ? '' : 'space-y-2'}`}>
                    
                    {/* Thinking/Reasoning Section */}
                    {msg.role === 'assistant' && msg.thinking && (
                        <ThinkingBlock text={msg.thinking} duration={msg.thinkingDuration} />
                    )}

                    {/* Main Content */}
                    <div
                        className={`rounded-2xl px-5 py-3.5 text-sm leading-relaxed whitespace-pre-wrap shadow-sm ${
                        msg.role === 'user'
                            ? 'bg-[#2d3748] text-white rounded-br-none'
                            : 'bg-white dark:bg-transparent text-gray-800 dark:text-gray-200 border border-gray-200 dark:border-gray-800 rounded-bl-none shadow-sm dark:shadow-none'
                        }`}
                    >
                        {msg.role === 'assistant' ? (
                        <div className="markdown-content">
                            <ReactMarkdown 
                                components={{
                                    code: ({node, inline, className, children, ...props}: any) => {
                                        return !inline ? (
                                            <div className="my-2 bg-gray-50 dark:bg-black/30 rounded-md overflow-hidden border border-gray-200 dark:border-gray-700/50">
                                                <div className="bg-gray-100 dark:bg-gray-800/50 px-3 py-1 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700/50 font-mono">Code</div>
                                                <pre className="p-3 overflow-x-auto text-xs font-mono text-gray-800 dark:text-gray-300">
                                                    <code {...props}>{children}</code>
                                                </pre>
                                            </div>
                                        ) : (
                                            <code className="bg-gray-100 dark:bg-gray-800 px-1 py-0.5 rounded text-xs font-mono text-blue-600 dark:text-blue-300" {...props}>
                                                {children}
                                            </code>
                                        )
                                    },
                                    a: ({node, href, children, ...props}: any) => {
                                        const isFootnote = /^\[\d+\]$/.test(String(children));
                                        return (
                                            <a 
                                                href={href} 
                                                target="_blank" 
                                                rel="noopener noreferrer"
                                                className={`${isFootnote ? "text-blue-500 hover:text-blue-600 font-bold no-underline ml-0.5" : "text-blue-600 dark:text-blue-400 hover:underline"}`}
                                                {...props}
                                            >
                                                {children}
                                            </a>
                                        );
                                    }
                                }}
                            >
                                {msg.content}
                            </ReactMarkdown>
                        </div>
                        ) : (
                        msg.content
                        )}
                    </div>

                    {/* Sources Chips */}
                    {msg.role === 'assistant' && msg.sources && msg.sources.length > 0 && (
                        <SourcesBlock sources={msg.sources} />
                    )}

                    {/* Message Metadata Footer (Model, Effort, Time) */}
                    {msg.role === 'assistant' && (
                        <div className="flex justify-end mt-1.5 gap-3 items-center select-none">
                            {/* Model & Effort */}
                            {(msg.model || msg.reasoningEffort) && (
                                <div className="text-[10px] text-gray-400 dark:text-gray-600 font-mono">
                                    {msg.model}
                                    {msg.reasoningEffort && <span className="mx-1 text-gray-300 dark:text-gray-700">•</span>}
                                    {msg.reasoningEffort}
                                </div>
                            )}

                            {/* Duration (only if not in ThinkingBlock) */}
                            {(!msg.thinking && msg.thinkingDuration) && (
                                <div className="text-[10px] text-gray-400 dark:text-gray-600 flex items-center gap-1 border-l border-gray-200 dark:border-gray-800 pl-2">
                                    <Clock size={10} />
                                    <span>{(msg.thinkingDuration / 1000).toFixed(1)}s</span>
                                </div>
                            )}
                        </div>
                    )}
                  </div>
              </div>
              
              {msg.role === 'user' && (
                <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-700 flex-shrink-0 flex items-center justify-center mt-1">
                  <User size={16} className="text-gray-600 dark:text-gray-300" />
                </div>
              )}
            </div>
          ))
        )}
        <div ref={messagesEndRef} className="h-4" />
      </div>

      {/* Input Area */}
      <div className="p-4 bg-white dark:bg-[#0d1117] transition-colors">
        <div className="max-w-4xl mx-auto">
          {attachments.length > 0 && (
              <div className="flex gap-2 mb-2 overflow-x-auto pb-2">
                  {attachments.map((file, index) => (
                      <div key={index} className="flex items-center gap-2 bg-gray-100 dark:bg-[#1f2937] text-gray-700 dark:text-gray-300 px-3 py-1.5 rounded-full text-xs border border-gray-200 dark:border-gray-700 transition-colors">
                          <span className="max-w-[100px] truncate">{file.name}</span>
                          <button onClick={() => removeAttachment(index)} className="hover:text-red-500 dark:hover:text-white">
                              <X size={12} />
                          </button>
                      </div>
                  ))}
              </div>
          )}
          <div className="relative bg-gray-50 dark:bg-[#161b22] border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg focus-within:ring-1 focus-within:ring-blue-500/50 focus-within:border-blue-500 transition-all">
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask anything..."
              className="w-full bg-transparent text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 text-sm px-4 py-3 pr-24 rounded-xl focus:outline-none resize-none max-h-48 min-h-[52px]"
              rows={1}
              style={{ height: 'auto', minHeight: '52px' }}
              onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
              }}
            />
            
            <div className="absolute right-2 bottom-1.5 flex items-center gap-1">
               <button 
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg transition-colors"
                  title="Attach file"
               >
                  <Paperclip size={18} />
               </button>
               <input 
                  type="file" 
                  multiple 
                  className="hidden" 
                  ref={fileInputRef} 
                  onChange={handleFileSelect}
               />
               <button
                  onClick={handleSend}
                  disabled={isLoading || (!inputValue.trim() && attachments.length === 0)}
                  className={`p-2 rounded-lg transition-all ${
                    isLoading || (!inputValue.trim() && attachments.length === 0)
                      ? 'text-gray-400 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700 shadow-md'
                  }`}
               >
                  <Send size={18} />
               </button>
            </div>
          </div>
          <div className="text-center mt-2 text-[10px] text-gray-400 dark:text-gray-600">
              GPT-5 can make mistakes. Consider checking important information.
          </div>
        </div>
      </div>
    </div>
  );
};
