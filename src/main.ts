import { marked } from 'marked';
import hljs from 'highlight.js';

// File System Access API types (not in standard TypeScript lib)
declare global {
  interface Window {
    showOpenFilePicker: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>;
  }

  interface OpenFilePickerOptions {
    types?: FilePickerAcceptType[];
    multiple?: boolean;
  }

  interface SaveFilePickerOptions {
    suggestedName?: string;
    types?: FilePickerAcceptType[];
  }

  interface FilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
  }

  interface FileSystemFileHandle {
    getFile(): Promise<File>;
    createWritable(): Promise<FileSystemWritableFileStream>;
  }

  interface FileSystemWritableFileStream extends WritableStream {
    write(data: string | Blob | ArrayBuffer): Promise<void>;
    close(): Promise<void>;
  }
}

// Configure marked with syntax highlighting using custom renderer
const renderer = new marked.Renderer();
renderer.code = function(code: string | { text: string; lang?: string }, language?: string): string {
  // Handle both old and new marked API
  const codeText = typeof code === 'string' ? code : code.text;
  const lang = typeof code === 'string' ? language : code.lang;

  if (lang && hljs.getLanguage(lang)) {
    try {
      const highlighted = hljs.highlight(codeText, { language: lang }).value;
      return `<pre><code class="hljs language-${lang}">${highlighted}</code></pre>`;
    } catch {
      // Fall through to auto-highlight
    }
  }
  const highlighted = hljs.highlightAuto(codeText).value;
  return `<pre><code class="hljs">${highlighted}</code></pre>`;
};

marked.setOptions({
  renderer,
  breaks: true,
  gfm: true,
});

// DOM Elements
const editor = document.getElementById('editor') as HTMLTextAreaElement;
const preview = document.getElementById('preview') as HTMLElement;
const docTitle = document.getElementById('doc-title') as HTMLInputElement;
const lineNumbers = document.getElementById('line-numbers') as HTMLElement;
const wordCountEl = document.getElementById('word-count') as HTMLElement;
const charCountEl = document.getElementById('char-count') as HTMLElement;
const cursorPosEl = document.getElementById('cursor-pos') as HTMLElement;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const mainContent = document.querySelector('.main-content') as HTMLElement;
const divider = document.getElementById('divider') as HTMLElement;
const toast = document.getElementById('toast') as HTMLElement;
const app = document.getElementById('app') as HTMLElement;
const exitFullscreenBtn = document.getElementById('exit-fullscreen') as HTMLButtonElement;

// State
let currentFileName = 'Untitled.md';
let isDragging = false;
let hasUnsavedChanges = false;
let isFullscreen = false;
let fileHandle: FileSystemFileHandle | null = null; // For File System Access API

// Local storage keys
const STORAGE_KEYS = {
  content: 'mdview_content',
  fileName: 'mdview_fileName',
  cursorPos: 'mdview_cursorPos',
  scrollPos: 'mdview_scrollPos',
  theme: 'mdview_theme',
  toolbarCollapsed: 'mdview_toolbar_collapsed',
};

// Theme management
function initTheme() {
  const savedTheme = localStorage.getItem(STORAGE_KEYS.theme);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = savedTheme || (prefersDark ? 'dark' : 'light');
  setTheme(theme);
}

function setTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem(STORAGE_KEYS.theme, theme);
}

function toggleTheme() {
  const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
  const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
  setTheme(newTheme);
  showToast(`Switched to ${newTheme} mode`);
}

// Toolbar collapse management
function initToolbarGroups() {
  // Load saved collapsed states
  let savedStates: Record<string, boolean> = {};
  try {
    const saved = localStorage.getItem(STORAGE_KEYS.toolbarCollapsed);
    if (saved) {
      savedStates = JSON.parse(saved);
    }
  } catch (e) {
    console.warn('Failed to load toolbar states:', e);
  }

  // Set up each group
  document.querySelectorAll('.toolbar-group[data-group]').forEach(group => {
    const groupEl = group as HTMLElement;
    const groupId = groupEl.dataset.group;
    const header = groupEl.querySelector('.toolbar-group-header') as HTMLButtonElement;

    if (!groupId || !header) return;

    // Restore collapsed state
    if (savedStates[groupId]) {
      groupEl.classList.add('collapsed');
      header.setAttribute('aria-expanded', 'false');
    }

    // Add click handler
    header.addEventListener('click', () => {
      const isCollapsed = groupEl.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', String(!isCollapsed));

      // Save state
      try {
        const states: Record<string, boolean> = JSON.parse(
          localStorage.getItem(STORAGE_KEYS.toolbarCollapsed) || '{}'
        );
        states[groupId] = isCollapsed;
        localStorage.setItem(STORAGE_KEYS.toolbarCollapsed, JSON.stringify(states));
      } catch (e) {
        console.warn('Failed to save toolbar state:', e);
      }
    });

    // Keyboard support
    header.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        header.click();
      }
    });
  });
}

// Save state to localStorage
function saveToLocalStorage() {
  try {
    localStorage.setItem(STORAGE_KEYS.content, editor.value);
    localStorage.setItem(STORAGE_KEYS.fileName, currentFileName);
    localStorage.setItem(STORAGE_KEYS.cursorPos, JSON.stringify({
      start: editor.selectionStart,
      end: editor.selectionEnd
    }));
    localStorage.setItem(STORAGE_KEYS.scrollPos, editor.scrollTop.toString());
  } catch (e) {
    console.warn('Failed to save to localStorage:', e);
  }
}

// Load state from localStorage
function loadFromLocalStorage(): boolean {
  try {
    const savedContent = localStorage.getItem(STORAGE_KEYS.content);
    const savedFileName = localStorage.getItem(STORAGE_KEYS.fileName);

    if (savedContent !== null) {
      editor.value = savedContent;
      currentFileName = savedFileName || 'Untitled.md';
      docTitle.value = currentFileName.replace(/\.md$|\.markdown$|\.txt$/, '');

      // Restore cursor position
      const cursorData = localStorage.getItem(STORAGE_KEYS.cursorPos);
      if (cursorData) {
        const { start, end } = JSON.parse(cursorData);
        editor.selectionStart = start;
        editor.selectionEnd = end;
      }

      // Restore scroll position after a brief delay
      const scrollPos = localStorage.getItem(STORAGE_KEYS.scrollPos);
      if (scrollPos) {
        setTimeout(() => {
          editor.scrollTop = parseInt(scrollPos, 10);
        }, 50);
      }

      return true;
    }
  } catch (e) {
    console.warn('Failed to load from localStorage:', e);
  }
  return false;
}

// Debounced auto-save
let autoSaveTimeout: number | null = null;
function scheduleAutoSave() {
  if (autoSaveTimeout) {
    clearTimeout(autoSaveTimeout);
  }
  autoSaveTimeout = window.setTimeout(() => {
    saveToLocalStorage();
  }, 1000); // Save 1 second after last change
}

// Initialize
function init() {
  // Initialize theme first (before content loads to prevent flash)
  initTheme();

  // Initialize collapsible toolbar groups
  initToolbarGroups();

  // Try to load from localStorage, otherwise show welcome content
  const loaded = loadFromLocalStorage();

  if (!loaded) {
    const welcomeContent = `# Welcome to MDView

A beautiful markdown editor crafted for writers and developers.

## Features

- **Live Preview** — See your markdown rendered in real-time
- **Import & Export** — Open .md files and save your work locally
- **Syntax Highlighting** — Code blocks are beautifully highlighted
- **Keyboard Shortcuts** — Work efficiently with familiar shortcuts

## Getting Started

Start typing in the editor on the left, and watch your content come alive in the preview on the right.

### Code Example

\`\`\`typescript
const greet = (name: string): string => {
  return \`Hello, \${name}!\`;
};

console.log(greet('World'));
\`\`\`

### Blockquotes

> "The best way to predict the future is to invent it."
> — Alan Kay

### Lists

1. First item
2. Second item
3. Third item

- Unordered item
- Another item
- One more thing

---

*Start editing to see the magic happen!*
`;
    editor.value = welcomeContent;
  }

  updatePreview();
  updateLineNumbers();
  updateStats();

  // Event listeners
  editor.addEventListener('input', handleEditorInput);
  editor.addEventListener('scroll', syncLineNumberScroll);
  editor.addEventListener('keydown', handleKeydown);
  editor.addEventListener('click', updateCursorPosition);
  editor.addEventListener('keyup', updateCursorPosition);

  // View toggle buttons
  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => handleViewToggle(btn as HTMLButtonElement));
  });

  // Toolbar buttons
  document.getElementById('btn-new')?.addEventListener('click', handleNew);
  document.getElementById('btn-open')?.addEventListener('click', handleOpen);
  document.getElementById('btn-save')?.addEventListener('click', handleSave);
  document.getElementById('btn-save-as')?.addEventListener('click', handleSaveAs);
  document.getElementById('btn-export')?.addEventListener('click', handleExport);

  // Undo/Redo buttons
  document.getElementById('btn-undo')?.addEventListener('click', handleUndo);
  document.getElementById('btn-redo')?.addEventListener('click', handleRedo);

  // Theme toggle
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);

  fileInput.addEventListener('change', handleFileOpenFallback);

  // Format buttons
  document.querySelectorAll('.format-btn').forEach(btn => {
    btn.addEventListener('click', () => handleFormat((btn as HTMLButtonElement).dataset.format || ''));
  });

  // Divider drag
  divider.addEventListener('mousedown', startDrag);
  document.addEventListener('mousemove', handleDrag);
  document.addEventListener('mouseup', stopDrag);

  // Exit fullscreen button
  exitFullscreenBtn.addEventListener('click', exitFullscreen);

  // Escape key to exit fullscreen
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isFullscreen) {
      e.preventDefault();
      exitFullscreen();
    }
  });

  // Title change
  docTitle.addEventListener('change', () => {
    currentFileName = docTitle.value.endsWith('.md') ? docTitle.value : `${docTitle.value}.md`;
    hasUnsavedChanges = true;
  });

  // Warn before leaving with unsaved changes
  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedChanges) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // Animate in
  setTimeout(() => {
    document.body.classList.add('loaded');
  }, 100);
}

// Update preview
function updatePreview() {
  const markdown = editor.value;
  preview.innerHTML = marked.parse(markdown) as string;
  hasUnsavedChanges = true;
}

// Update line numbers
function updateLineNumbers() {
  const lines = editor.value.split('\n');
  const numbers = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
  lineNumbers.innerHTML = numbers;
}

// Sync scroll between line numbers and editor
function syncLineNumberScroll() {
  lineNumbers.scrollTop = editor.scrollTop;
}

// Update word and character count
function updateStats() {
  const text = editor.value;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;

  wordCountEl.textContent = `${words} word${words !== 1 ? 's' : ''}`;
  charCountEl.textContent = `${chars} char${chars !== 1 ? 's' : ''}`;
}

// Update cursor position
function updateCursorPosition() {
  const text = editor.value.substring(0, editor.selectionStart);
  const lines = text.split('\n');
  const line = lines.length;
  const col = lines[lines.length - 1].length + 1;

  cursorPosEl.textContent = `Ln ${line}, Col ${col}`;
}

// Handle editor input
function handleEditorInput() {
  updatePreview();
  updateLineNumbers();
  updateStats();
  scheduleAutoSave(); // Auto-save to localStorage
}

// Handle keyboard shortcuts
function handleKeydown(e: KeyboardEvent) {
  if (e.ctrlKey || e.metaKey) {
    // Handle Ctrl+Shift combinations
    if (e.shiftKey) {
      switch (e.key.toLowerCase()) {
        case 'z':
          e.preventDefault();
          handleRedo();
          return;
        case 's':
          e.preventDefault();
          handleSaveAs();
          return;
      }
    }

    switch (e.key.toLowerCase()) {
      case 'b':
        e.preventDefault();
        handleFormat('bold');
        break;
      case 'i':
        e.preventDefault();
        handleFormat('italic');
        break;
      case 'k':
        e.preventDefault();
        handleFormat('link');
        break;
      case 's':
        e.preventDefault();
        handleSave();
        break;
      case 'y':
        e.preventDefault();
        handleRedo();
        break;
      case 'z':
        // Let native undo work, but update preview
        setTimeout(handleEditorInput, 0);
        break;
    }
  }

  // Tab handling
  if (e.key === 'Tab') {
    e.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = editor.value.substring(0, start) + '  ' + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + 2;
    handleEditorInput();
  }
}

// Handle formatting
// Check if text is wrapped with markers (for toggle detection)
function isWrapped(text: string, prefix: string, suffix: string): boolean {
  return text.startsWith(prefix) && text.endsWith(suffix) && text.length >= prefix.length + suffix.length;
}

// Unwrap text by removing prefix and suffix
function unwrap(text: string, prefix: string, suffix: string): string {
  return text.slice(prefix.length, -suffix.length || undefined);
}

// Insert text at selection, preserving undo/redo stack
function insertAtSelection(text: string, selectStart?: number, selectEnd?: number) {
  editor.focus();

  // Use execCommand for better undo/redo support
  // This is deprecated but still works and preserves undo stack
  const success = document.execCommand('insertText', false, text);

  if (!success) {
    // Fallback: manual insertion (loses undo for this action)
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = editor.value.substring(0, start) + text + editor.value.substring(end);
    editor.selectionStart = editor.selectionEnd = start + text.length;
  }

  // Adjust selection if specified
  if (selectStart !== undefined && selectEnd !== undefined) {
    const basePos = editor.selectionStart - text.length;
    editor.selectionStart = basePos + selectStart;
    editor.selectionEnd = basePos + selectEnd;
  }

  handleEditorInput();
}

// Expand selection to include surrounding markers
function expandSelection(prefix: string, suffix: string): { expanded: boolean; start: number; end: number } {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  const text = editor.value;

  // Check if markers are just outside the selection
  const beforeStart = Math.max(0, start - prefix.length);
  const afterEnd = Math.min(text.length, end + suffix.length);

  const textBefore = text.substring(beforeStart, start);
  const textAfter = text.substring(end, afterEnd);

  if (textBefore === prefix && textAfter === suffix) {
    return { expanded: true, start: beforeStart, end: afterEnd };
  }

  return { expanded: false, start, end };
}

function handleFormat(format: string) {
  const start = editor.selectionStart;
  const end = editor.selectionEnd;
  let selectedText = editor.value.substring(start, end);

  // Define format markers
  const formats: Record<string, { prefix: string; suffix: string; placeholder: string }> = {
    bold: { prefix: '**', suffix: '**', placeholder: 'bold text' },
    italic: { prefix: '*', suffix: '*', placeholder: 'italic text' },
    strikethrough: { prefix: '~~', suffix: '~~', placeholder: 'strikethrough' },
    code: { prefix: '`', suffix: '`', placeholder: 'code' },
  };

  // Handle toggleable inline formats
  if (formats[format]) {
    const { prefix, suffix, placeholder } = formats[format];

    // Check if selected text is already formatted
    if (selectedText && isWrapped(selectedText, prefix, suffix)) {
      // Remove formatting
      const unwrapped = unwrap(selectedText, prefix, suffix);
      insertAtSelection(unwrapped);
      return;
    }

    // Check if markers are just outside selection
    const expanded = expandSelection(prefix, suffix);
    if (expanded.expanded) {
      // Select the markers too, then remove them
      editor.selectionStart = expanded.start;
      editor.selectionEnd = expanded.end;
      const innerText = editor.value.substring(expanded.start + prefix.length, expanded.end - suffix.length);
      insertAtSelection(innerText);
      return;
    }

    // Add formatting
    const textToWrap = selectedText || placeholder;
    const formatted = `${prefix}${textToWrap}${suffix}`;
    insertAtSelection(formatted);

    // If no text was selected, position cursor inside markers
    if (!selectedText) {
      editor.selectionStart = start + prefix.length;
      editor.selectionEnd = start + prefix.length + placeholder.length;
    }
    return;
  }

  // Handle other formats (non-toggleable)
  let replacement = '';
  let selectRange: [number, number] | undefined;

  switch (format) {
    case 'link':
      if (selectedText) {
        replacement = `[${selectedText}](url)`;
        selectRange = [selectedText.length + 3, selectedText.length + 6]; // Select "url"
      } else {
        replacement = '[link text](url)';
        selectRange = [1, 10]; // Select "link text"
      }
      break;
    case 'h1':
      replacement = `# ${selectedText || 'Heading 1'}`;
      if (!selectedText) selectRange = [2, replacement.length];
      break;
    case 'h2':
      replacement = `## ${selectedText || 'Heading 2'}`;
      if (!selectedText) selectRange = [3, replacement.length];
      break;
    case 'h3':
      replacement = `### ${selectedText || 'Heading 3'}`;
      if (!selectedText) selectRange = [4, replacement.length];
      break;
    case 'quote':
      if (selectedText) {
        // Toggle: check if already quoted
        const lines = selectedText.split('\n');
        const allQuoted = lines.every(line => line.startsWith('> '));
        if (allQuoted) {
          replacement = lines.map(line => line.slice(2)).join('\n');
        } else {
          replacement = lines.map(line => `> ${line}`).join('\n');
        }
      } else {
        replacement = '> Quote';
        selectRange = [2, 7];
      }
      break;
    case 'ul':
      if (selectedText) {
        const lines = selectedText.split('\n');
        const allListed = lines.every(line => line.match(/^- /));
        if (allListed) {
          replacement = lines.map(line => line.slice(2)).join('\n');
        } else {
          replacement = lines.map(line => `- ${line}`).join('\n');
        }
      } else {
        replacement = '- List item';
        selectRange = [2, 11];
      }
      break;
    case 'ol':
      if (selectedText) {
        const lines = selectedText.split('\n');
        const allNumbered = lines.every(line => line.match(/^\d+\. /));
        if (allNumbered) {
          replacement = lines.map(line => line.replace(/^\d+\. /, '')).join('\n');
        } else {
          replacement = lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
        }
      } else {
        replacement = '1. List item';
        selectRange = [3, 12];
      }
      break;
    case 'codeblock':
      if (selectedText) {
        // Check if already a code block
        if (selectedText.startsWith('```\n') && selectedText.endsWith('\n```')) {
          replacement = selectedText.slice(4, -4);
        } else {
          replacement = `\`\`\`\n${selectedText}\n\`\`\``;
        }
      } else {
        replacement = '```\ncode here\n```';
        selectRange = [4, 13];
      }
      break;
    default:
      return;
  }

  insertAtSelection(replacement);

  if (selectRange) {
    const basePos = editor.selectionStart - replacement.length;
    editor.selectionStart = basePos + selectRange[0];
    editor.selectionEnd = basePos + selectRange[1];
  }
}

// Handle view toggle
function handleViewToggle(btn: HTMLButtonElement) {
  const view = btn.dataset.view;
  if (!view) return;

  document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  mainContent.dataset.view = view;

  // Enable fullscreen mode for edit and preview views
  if (view === 'edit' || view === 'preview') {
    enterFullscreen();
  } else {
    exitFullscreen();
  }
}

// Enter fullscreen mode
function enterFullscreen() {
  isFullscreen = true;
  app.classList.add('fullscreen-mode');

  // Focus editor in edit mode
  if (mainContent.dataset.view === 'edit') {
    editor.focus();
  }
}

// Exit fullscreen mode
function exitFullscreen() {
  if (!isFullscreen) return;

  isFullscreen = false;
  app.classList.remove('fullscreen-mode');

  // Return to split view
  mainContent.dataset.view = 'split';
  document.querySelectorAll('.toggle-btn').forEach(b => {
    b.classList.toggle('active', (b as HTMLButtonElement).dataset.view === 'split');
  });
}

// Handle undo
function handleUndo() {
  editor.focus();
  document.execCommand('undo', false);
  handleEditorInput();
}

// Handle redo
function handleRedo() {
  editor.focus();
  document.execCommand('redo', false);
  handleEditorInput();
}

// Handle new document
function handleNew() {
  if (hasUnsavedChanges && !confirm('Discard unsaved changes?')) return;

  editor.value = '';
  docTitle.value = 'Untitled';
  currentFileName = 'Untitled.md';
  fileHandle = null; // Clear file handle for new document
  hasUnsavedChanges = false;

  // Clear localStorage for fresh start
  localStorage.removeItem(STORAGE_KEYS.content);
  localStorage.removeItem(STORAGE_KEYS.fileName);
  localStorage.removeItem(STORAGE_KEYS.cursorPos);
  localStorage.removeItem(STORAGE_KEYS.scrollPos);

  handleEditorInput();
  showToast('New document created');
}

// Handle file open
// Handle file open - try File System Access API first, fallback to input
async function handleOpen() {
  // Check if File System Access API is supported
  if ('showOpenFilePicker' in window) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: 'Markdown Files',
          accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] }
        }],
        multiple: false
      });

      fileHandle = handle;
      const file = await handle.getFile();
      const content = await file.text();

      editor.value = content;
      currentFileName = file.name;
      docTitle.value = file.name.replace(/\.md$|\.markdown$|\.txt$/, '');
      hasUnsavedChanges = false;
      handleEditorInput();
      showToast(`Opened: ${file.name}`);
    } catch (err) {
      // User cancelled or error - silently ignore cancel
      if ((err as Error).name !== 'AbortError') {
        console.error('Error opening file:', err);
      }
    }
  } else {
    // Fallback to file input for browsers without File System Access API
    fileInput.click();
  }
}

// Fallback file open handler for older browsers
function handleFileOpenFallback(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  fileHandle = null; // No handle in fallback mode

  const reader = new FileReader();
  reader.onload = (event) => {
    editor.value = event.target?.result as string;
    currentFileName = file.name;
    docTitle.value = file.name.replace(/\.md$|\.markdown$|\.txt$/, '');
    hasUnsavedChanges = false;
    handleEditorInput();
    showToast(`Opened: ${file.name}`);
  };
  reader.readAsText(file);

  // Reset input so same file can be opened again
  (e.target as HTMLInputElement).value = '';
}

// Handle save - write to same file if possible
async function handleSave() {
  const content = editor.value;

  // If we have a file handle, try to save to the same file
  if (fileHandle) {
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(content);
      await writable.close();
      hasUnsavedChanges = false;
      showToast(`Saved: ${currentFileName}`);
      return;
    } catch (err) {
      console.error('Error saving to file:', err);
      // Fall through to Save As behavior
    }
  }

  // No file handle or save failed - use Save As
  await handleSaveAs();
}

// Handle Save As - always prompts for location
async function handleSaveAs() {
  const content = editor.value;

  // Try File System Access API first
  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: currentFileName,
        types: [{
          description: 'Markdown Files',
          accept: { 'text/markdown': ['.md'] }
        }]
      });

      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();

      fileHandle = handle;
      const file = await handle.getFile();
      currentFileName = file.name;
      docTitle.value = file.name.replace(/\.md$|\.markdown$|\.txt$/, '');
      hasUnsavedChanges = false;
      showToast(`Saved: ${currentFileName}`);
      return;
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Error saving file:', err);
      }
      return;
    }
  }

  // Fallback: download file
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentFileName;
  a.click();
  URL.revokeObjectURL(url);
  hasUnsavedChanges = false;
  showToast(`Downloaded: ${currentFileName}`);
}

// Handle export to HTML
function handleExport() {
  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${docTitle.value}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Spectral:ital,wght@0,300;0,400;0,500;0,600;1,300;1,400&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Spectral', Georgia, serif;
      line-height: 1.8;
      color: #1a1a1a;
      max-width: 720px;
      margin: 0 auto;
      padding: 4rem 2rem;
      background: #fefefe;
    }
    h1, h2, h3, h4, h5, h6 {
      font-family: 'Spectral', Georgia, serif;
      font-weight: 600;
      margin: 2rem 0 1rem;
      line-height: 1.3;
    }
    h1 { font-size: 2.5rem; border-bottom: 2px solid #c75d3a; padding-bottom: 0.5rem; }
    h2 { font-size: 1.75rem; color: #333; }
    h3 { font-size: 1.35rem; }
    p { margin: 1rem 0; }
    a { color: #c75d3a; text-decoration: none; border-bottom: 1px solid transparent; transition: border-color 0.2s; }
    a:hover { border-bottom-color: #c75d3a; }
    pre { background: #0d0d0d; color: #f5f0e8; padding: 1.5rem; border-radius: 4px; overflow-x: auto; margin: 1.5rem 0; }
    code { font-family: 'JetBrains Mono', monospace; font-size: 0.9em; }
    :not(pre) > code { background: #f0ebe3; padding: 0.2em 0.4em; border-radius: 3px; color: #c75d3a; }
    blockquote { border-left: 4px solid #c75d3a; padding-left: 1.5rem; margin: 1.5rem 0; font-style: italic; color: #555; }
    ul, ol { margin: 1rem 0; padding-left: 2rem; }
    li { margin: 0.5rem 0; }
    hr { border: none; border-top: 1px solid #ddd; margin: 2rem 0; }
    img { max-width: 100%; height: auto; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.75rem; text-align: left; }
    th { background: #f5f0e8; }
  </style>
</head>
<body>
  ${preview.innerHTML}
</body>
</html>`;

  const blob = new Blob([htmlContent], { type: 'text/html' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = currentFileName.replace(/\.md$/, '.html');
  a.click();

  URL.revokeObjectURL(url);
  showToast('Exported as HTML');
}

// Divider drag functionality
function startDrag(e: MouseEvent) {
  isDragging = true;
  divider.classList.add('dragging');
  e.preventDefault();
}

function handleDrag(e: MouseEvent) {
  if (!isDragging) return;

  const container = mainContent;
  const containerRect = container.getBoundingClientRect();
  const percentage = ((e.clientX - containerRect.left) / containerRect.width) * 100;
  const clampedPercentage = Math.min(Math.max(percentage, 20), 80);

  const editorPane = container.querySelector('.editor-pane') as HTMLElement;
  const previewPane = container.querySelector('.preview-pane') as HTMLElement;

  editorPane.style.width = `${clampedPercentage}%`;
  previewPane.style.width = `${100 - clampedPercentage}%`;
}

function stopDrag() {
  if (isDragging) {
    isDragging = false;
    divider.classList.remove('dragging');
  }
}

// Show toast notification
function showToast(message: string) {
  toast.textContent = message;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

// Initialize app
init();
