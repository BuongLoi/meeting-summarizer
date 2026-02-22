/**
 * ╔══════════════════════════════════════════════════╗
 * ║  MEETING SUMMARIZER - popup.js                  ║
 * ║                                                 ║
 * ║  File này chứa toàn bộ logic xử lý:            ║
 * ║  - File handling & validation                   ║
 * ║  - Gemini API calls (transcription + summary)   ║
 * ║  - UI rendering (summary, actions, transcript)  ║
 * ║  - Clipboard & Markdown export                  ║
 * ║                                                 ║
 * ║  CHROME EXTENSION NOTES:                        ║
 * ║  - File này giữ nguyên tên popup.js             ║
 * ║  - StorageHelper.get/set sẽ tự chuyển sang      ║
 * ║    chrome.storage.local khi detect extension env ║
 * ║  - Không dùng window.open, eval, hay inline     ║
 * ║    event handlers → tương thích CSP extension   ║
 * ╚══════════════════════════════════════════════════╝
 */

const MeetingSummarizer = (() => {
  'use strict';

  // ═══════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════
  const Config = {
    MAX_FILE_SIZE: 25 * 1024 * 1024, // 25MB
    ACCEPTED_TYPES: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a', 'audio/m4a'],
    ACCEPTED_EXTENSIONS: ['.mp3', '.wav', '.m4a'],
    GEMINI_API_BASE: 'https://generativelanguage.googleapis.com/v1beta',
    GEMINI_MODEL: 'gemini-2.0-flash',
    TOAST_DURATION: 3500,
  };

  // ═══════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════
  const State = {
    selectedFile: null,
    audioBase64: null,
    audioDuration: null,
    isProcessing: false,
    results: {
      transcript: '',
      summary: [],
      actionItems: [],
    },
  };

  // ═══════════════════════════════════════
  // STORAGE HELPER
  // Wrapper để dễ chuyển sang chrome.storage
  // ═══════════════════════════════════════
  const StorageHelper = {
    _isChromeExtension() {
      return typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
    },

    async get(key) {
      if (this._isChromeExtension()) {
        return new Promise(resolve => {
          chrome.storage.local.get([key], (result) => resolve(result[key] || null));
        });
      }
      try {
        const val = localStorage.getItem(key);
        return val ? JSON.parse(val) : null;
      } catch {
        return null;
      }
    },

    async set(key, value) {
      if (this._isChromeExtension()) {
        return new Promise(resolve => {
          chrome.storage.local.set({ [key]: value }, resolve);
        });
      }
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch { /* quota exceeded */ }
    },
  };

  // ═══════════════════════════════════════
  // DOM REFERENCES
  // ═══════════════════════════════════════
  let DOM = {};

  function cacheDOMRefs() {
    DOM = {
      // Upload
      uploadZone: document.getElementById('uploadZone'),
      fileInput: document.getElementById('fileInput'),
      fileInfo: document.getElementById('fileInfo'),
      fileName: document.getElementById('fileName'),
      fileSize: document.getElementById('fileSize'),
      fileDuration: document.getElementById('fileDuration'),
      fileWarning: document.getElementById('fileWarning'),

      // Config
      meetingLang: document.getElementById('meetingLang'),
      detailLevel: document.getElementById('detailLevel'),
      outputLang: document.getElementById('outputLang'),
      summaryTone: document.getElementById('summaryTone'),
      focusActions: document.getElementById('focusActions'),
      apiKey: document.getElementById('apiKey'),

      // Submit
      btnSubmit: document.getElementById('btnSubmit'),
      loadingText: document.getElementById('loadingText'),
      stepIndicator: document.getElementById('stepIndicator'),
      step1: document.getElementById('step1'),
      step2: document.getElementById('step2'),
      step3: document.getElementById('step3'),
      errorMessage: document.getElementById('errorMessage'),

      // Results
      resultsEmpty: document.getElementById('resultsEmpty'),
      resultsContent: document.getElementById('resultsContent'),
      summaryList: document.getElementById('summaryList'),
      actionItemsList: document.getElementById('actionItemsList'),
      transcriptBox: document.getElementById('transcriptBox'),

      // Actions
      btnCopy: document.getElementById('btnCopy'),
      btnMarkdown: document.getElementById('btnMarkdown'),

      // Toast
      toastContainer: document.getElementById('toastContainer'),
    };
  }

  // ═══════════════════════════════════════
  // UTILITY FUNCTIONS
  // ═══════════════════════════════════════
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return 'Không xác định';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    if (mins === 0) return `${secs} giây`;
    return `${mins} phút ${secs > 0 ? secs + ' giây' : ''}`.trim();
  }

  function estimateMeetingDuration(seconds) {
    if (!seconds) return '';
    const mins = Math.round(seconds / 60);
    if (mins < 5) return '~Cuộc họp ngắn (<5 phút)';
    if (mins < 15) return `~${mins} phút (họp nhanh)`;
    if (mins < 45) return `~${mins} phút (họp tiêu chuẩn)`;
    const hrs = Math.floor(mins / 60);
    const remainMins = mins % 60;
    return `~${hrs}h${remainMins > 0 ? remainMins + 'p' : ''} (họp dài)`;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // Remove data URL prefix to get raw base64
        const base64 = reader.result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = () => reject(new Error('Không thể đọc file'));
      reader.readAsDataURL(file);
    });
  }

  function getAudioDuration(file) {
    return new Promise((resolve) => {
      const audio = new Audio();
      const url = URL.createObjectURL(file);
      audio.addEventListener('loadedmetadata', () => {
        resolve(audio.duration);
        URL.revokeObjectURL(url);
      });
      audio.addEventListener('error', () => {
        resolve(null);
        URL.revokeObjectURL(url);
      });
      audio.src = url;
    });
  }

  function getMimeType(file) {
    const ext = file.name.toLowerCase().split('.').pop();
    const mimeMap = {
      'mp3': 'audio/mpeg',
      'wav': 'audio/wav',
      'm4a': 'audio/mp4',
    };
    return mimeMap[ext] || file.type || 'audio/mpeg';
  }

  // ═══════════════════════════════════════
  // UI MODULE
  // ═══════════════════════════════════════
  const UI = {
    showToast(message, type = 'info') {
      const toast = document.createElement('div');
      toast.className = `toast toast--${type}`;

      const icons = { success: '✅', error: '❌', info: 'ℹ️' };
      toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;

      DOM.toastContainer.appendChild(toast);

      setTimeout(() => {
        toast.classList.add('toast-out');
        toast.addEventListener('animationend', () => toast.remove());
      }, Config.TOAST_DURATION);
    },

    showLoading() {
      State.isProcessing = true;
      DOM.btnSubmit.disabled = true;
      DOM.btnSubmit.classList.add('loading');
      DOM.btnSubmit.querySelector('.loading-btn-text').style.display = 'inline';
      DOM.loadingText.classList.add('visible');
      DOM.stepIndicator.classList.add('visible');
      DOM.errorMessage.classList.remove('visible');

      // Reset steps
      [DOM.step1, DOM.step2, DOM.step3].forEach(s => {
        s.className = 'step-indicator__step';
      });
    },

    hideLoading() {
      State.isProcessing = false;
      DOM.btnSubmit.classList.remove('loading');
      DOM.btnSubmit.querySelector('.loading-btn-text').style.display = 'none';
      DOM.loadingText.classList.remove('visible');
      DOM.stepIndicator.classList.remove('visible');
      UI.updateSubmitButton();
    },

    setStep(stepNum) {
      const steps = [DOM.step1, DOM.step2, DOM.step3];
      steps.forEach((step, i) => {
        if (i + 1 < stepNum) {
          step.className = 'step-indicator__step done';
        } else if (i + 1 === stepNum) {
          step.className = 'step-indicator__step active';
        } else {
          step.className = 'step-indicator__step';
        }
      });
    },

    showError(message) {
      DOM.errorMessage.textContent = '⚠️ ' + message;
      DOM.errorMessage.classList.add('visible');
    },

    hideError() {
      DOM.errorMessage.classList.remove('visible');
    },

    updateSubmitButton() {
      const hasFile = !!State.selectedFile;
      const hasKey = !!DOM.apiKey.value.trim();
      DOM.btnSubmit.disabled = !hasFile || !hasKey || State.isProcessing;
    },

    renderSummary(summaryPoints) {
      DOM.summaryList.innerHTML = '';
      summaryPoints.forEach(point => {
        const li = document.createElement('li');
        li.textContent = point;
        DOM.summaryList.appendChild(li);
      });
    },

    renderActionItems(items) {
      DOM.actionItemsList.innerHTML = '';
      items.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'action-item';
        div.innerHTML = `
          <input type="checkbox" id="action-${index}" />
          <div class="action-item__content">
            <div class="action-item__desc">${escapeHtml(item.description)}</div>
            <div class="action-item__meta">
              ${item.assignee ? `<span class="action-item__tag action-item__tag--person">👤 ${escapeHtml(item.assignee)}</span>` : ''}
              ${item.deadline ? `<span class="action-item__tag action-item__tag--deadline">📅 ${escapeHtml(item.deadline)}</span>` : ''}
            </div>
          </div>
        `;

        // Checkbox toggle
        const checkbox = div.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', () => {
          div.classList.toggle('checked', checkbox.checked);
        });

        DOM.actionItemsList.appendChild(div);
      });
    },

    renderTranscript(transcript) {
      DOM.transcriptBox.textContent = transcript;
    },

    showResults() {
      DOM.resultsEmpty.style.display = 'none';
      DOM.resultsContent.style.display = 'block';
    },

    resetResults() {
      DOM.resultsEmpty.style.display = '';
      DOM.resultsContent.style.display = 'none';
      DOM.summaryList.innerHTML = '';
      DOM.actionItemsList.innerHTML = '';
      DOM.transcriptBox.textContent = '';
    },

    activateTab(tabId) {
      // Update buttons
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tab === tabId);
      });
      // Update content
      document.querySelectorAll('.tab-content').forEach(tc => {
        tc.classList.toggle('active', tc.id === `tab-${tabId}`);
      });
    },
  };

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ═══════════════════════════════════════
  // GEMINI API MODULE
  // ═══════════════════════════════════════
  const API = {
    _getApiKey() {
      return DOM.apiKey.value.trim();
    },

    _buildApiUrl(endpoint) {
      return `${Config.GEMINI_API_BASE}/${endpoint}?key=${this._getApiKey()}`;
    },

    /**
     * Gọi Gemini để chuyển audio thành văn bản (transcript)
     */
    async callGeminiForTranscription(audioBase64, mimeType) {
      const meetingLang = DOM.meetingLang.value;
      const langMap = { vi: 'Vietnamese', en: 'English', auto: 'auto-detect' };
      const langName = langMap[meetingLang] || 'auto-detect';

      const prompt = `You are an expert audio transcriptionist. Please transcribe the following audio recording accurately.

Rules:
- The audio is primarily in ${langName} language${meetingLang === 'auto' ? ' (auto-detect the language)' : ''}.
- Transcribe word-by-word as accurately as possible.
- Use proper punctuation and paragraph breaks.
- If there are multiple speakers, try to distinguish them (e.g., "Speaker 1:", "Speaker 2:").
- If any part is unclear, mark it as [unclear].
- DO NOT summarize. Provide the FULL transcript only.
- Output the transcript as plain text, nothing else.`;

      const url = this._buildApiUrl(`models/${Config.GEMINI_MODEL}:generateContent`);

      const body = {
        contents: [{
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: mimeType,
                data: audioBase64
              }
            }
          ]
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const msg = errorData?.error?.message || `HTTP ${response.status}`;
        throw new Error(`Transcription failed: ${msg}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Không nhận được transcript từ Gemini.');

      return text.trim();
    },

    /**
     * Gọi Gemini để tóm tắt + trích xuất action items từ transcript
     */
    async callGeminiForSummary(transcript) {
      const detailLevel = DOM.detailLevel.value;
      const outputLang = DOM.outputLang.value;
      const summaryTone = DOM.summaryTone.value;
      const focusActions = DOM.focusActions.checked;

      // Build config
      const langMap = { vi: 'Vietnamese', en: 'English', same: 'same language as the transcript' };
      const outputLangName = langMap[outputLang] || 'Vietnamese';

      const detailMap = {
        brief: '3-5 key points maximum, very concise',
        standard: '5-8 key points with moderate detail',
        detailed: '8-12 key points with comprehensive detail'
      };
      const detailInstruction = detailMap[detailLevel] || detailMap.standard;

      const toneMap = {
        neutral: 'neutral and objective',
        friendly: 'friendly and approachable',
        formal: 'formal and professional'
      };
      const toneInstruction = toneMap[summaryTone] || toneMap.neutral;

      const prompt = `You are an expert meeting note taker. Analyze the following meeting transcript and provide a structured output.

OUTPUT LANGUAGE: ${outputLangName}
TONE: ${toneInstruction}
DETAIL LEVEL: ${detailInstruction}
${focusActions ? 'PRIORITY: Focus especially on action items, decisions, and commitments made during the meeting.' : ''}

Please respond ONLY with valid JSON (no markdown code fences, no extra text) in this exact format:
{
  "summary": [
    "Key point 1",
    "Key point 2"
  ],
  "actionItems": [
    {
      "description": "What needs to be done",
      "assignee": "Person name or null if not mentioned",
      "deadline": "Deadline or null if not mentioned"
    }
  ]
}

Rules:
- summary: Array of strings. ${detailInstruction}. Each point should be a complete, clear statement.
- actionItems: Array of objects. Extract ALL action items, tasks, commitments, and follow-ups mentioned.
  - For each item, try to identify WHO is responsible and WHEN it should be done.
  - If the person or deadline is not clear, set to null.
- All output text must be in ${outputLangName}.

TRANSCRIPT:
"""
${transcript}
"""`;

      const url = this._buildApiUrl(`models/${Config.GEMINI_MODEL}:generateContent`);

      const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        }
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const msg = errorData?.error?.message || `HTTP ${response.status}`;
        throw new Error(`Summary failed: ${msg}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Không nhận được tóm tắt từ Gemini.');

      // Parse JSON response
      try {
        // Clean potential markdown fences
        const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
        return JSON.parse(cleaned);
      } catch (e) {
        console.error('Failed to parse summary JSON:', text);
        throw new Error('Không thể phân tích kết quả tóm tắt. Vui lòng thử lại.');
      }
    },
  };

  // ═══════════════════════════════════════
  // EVENT HANDLERS
  // ═══════════════════════════════════════
  async function handleFileSelect(file) {
    // Validate extension
    const ext = '.' + file.name.toLowerCase().split('.').pop();
    if (!Config.ACCEPTED_EXTENSIONS.includes(ext)) {
      UI.showToast('File không được hỗ trợ. Vui lòng chọn .mp3, .wav, hoặc .m4a', 'error');
      return;
    }

    // Validate size
    if (file.size > Config.MAX_FILE_SIZE) {
      UI.showToast(`File quá lớn (${formatFileSize(file.size)}). Tối đa 25MB.`, 'error');
      return;
    }

    State.selectedFile = file;

    // Show file info
    DOM.fileInfo.classList.add('visible');
    DOM.fileName.textContent = file.name;
    DOM.fileSize.textContent = '📦 ' + formatFileSize(file.size);

    // Get duration
    DOM.fileDuration.textContent = '⏱️ Đang tính...';
    const duration = await getAudioDuration(file);
    State.audioDuration = duration;

    if (duration) {
      const est = estimateMeetingDuration(duration);
      DOM.fileDuration.textContent = `⏱️ ${formatDuration(duration)}${est ? ' – ' + est : ''}`;
    } else {
      DOM.fileDuration.textContent = '⏱️ Không xác định';
    }

    // Warn large files
    if (file.size > 15 * 1024 * 1024) {
      DOM.fileWarning.style.display = 'block';
      DOM.fileWarning.textContent = '⚠️ File lớn, thời gian xử lý có thể lâu hơn.';
    } else {
      DOM.fileWarning.style.display = 'none';
    }

    UI.updateSubmitButton();
    UI.hideError();
  }

  async function handleSubmit() {
    if (State.isProcessing || !State.selectedFile) return;

    const apiKey = DOM.apiKey.value.trim();
    if (!apiKey) {
      UI.showError('Vui lòng nhập Gemini API Key.');
      return;
    }

    // Save API key locally
    StorageHelper.set('gemini_api_key', apiKey);

    UI.showLoading();
    UI.resetResults();

    try {
      // Step 1: Convert audio to base64
      UI.setStep(1);
      const mimeType = getMimeType(State.selectedFile);
      const audioBase64 = await fileToBase64(State.selectedFile);

      // Step 2: Transcribe
      const transcript = await API.callGeminiForTranscription(audioBase64, mimeType);
      State.results.transcript = transcript;

      // Step 3: Summarize
      UI.setStep(2);
      const summaryResult = await API.callGeminiForSummary(transcript);

      State.results.summary = summaryResult.summary || [];
      State.results.actionItems = summaryResult.actionItems || [];

      // Step 3: Render
      UI.setStep(3);

      // Small delay for UX
      await new Promise(r => setTimeout(r, 500));

      UI.renderSummary(State.results.summary);
      UI.renderActionItems(State.results.actionItems);
      UI.renderTranscript(State.results.transcript);
      UI.showResults();
      UI.activateTab('summary');

      UI.showToast('🎉 Tóm tắt hoàn tất! Xem kết quả bên phải.', 'success');

    } catch (error) {
      console.error('Processing error:', error);
      UI.showError(error.message || 'Đã xảy ra lỗi không xác định.');
      UI.showToast('Xử lý thất bại: ' + error.message, 'error');
    } finally {
      UI.hideLoading();
    }
  }

  function handleCopySummary() {
    const { summary, actionItems } = State.results;
    if (!summary.length && !actionItems.length) {
      UI.showToast('Chưa có kết quả để copy.', 'info');
      return;
    }

    let text = '📋 TÓM TẮT CUỘC HỌP\n';
    text += '═'.repeat(30) + '\n\n';

    if (summary.length) {
      text += '📌 Tóm tắt chính:\n';
      summary.forEach((s, i) => {
        text += `  ${i + 1}. ${s}\n`;
      });
      text += '\n';
    }

    if (actionItems.length) {
      text += '✅ Action Items:\n';
      actionItems.forEach((item, i) => {
        text += `  ${i + 1}. ${item.description}`;
        if (item.assignee) text += ` (👤 ${item.assignee})`;
        if (item.deadline) text += ` [📅 ${item.deadline}]`;
        text += '\n';
      });
    }

    navigator.clipboard.writeText(text).then(() => {
      UI.showToast('Đã copy tóm tắt vào clipboard! 📋', 'success');
    }).catch(() => {
      UI.showToast('Không thể copy. Hãy thử lại.', 'error');
    });
  }

  function handleExportMarkdown() {
    const { summary, actionItems, transcript } = State.results;
    if (!summary.length && !actionItems.length && !transcript) {
      UI.showToast('Chưa có kết quả để xuất.', 'info');
      return;
    }

    let md = '# 📋 Tóm tắt cuộc họp\n\n';
    md += `> 📅 Ngày: ${new Date().toLocaleDateString('vi-VN')}\n\n`;

    if (summary.length) {
      md += '## 📌 Tóm tắt chính\n\n';
      summary.forEach(s => {
        md += `- ${s}\n`;
      });
      md += '\n';
    }

    if (actionItems.length) {
      md += '## ✅ Action Items\n\n';
      md += '| # | Mô tả | Phụ trách | Deadline |\n';
      md += '|---|--------|-----------|----------|\n';
      actionItems.forEach((item, i) => {
        md += `| ${i + 1} | ${item.description} | ${item.assignee || '—'} | ${item.deadline || '—'} |\n`;
      });
      md += '\n';
    }

    if (transcript) {
      md += '## 📝 Transcript đầy đủ\n\n';
      md += '```\n' + transcript + '\n```\n';
    }

    navigator.clipboard.writeText(md).then(() => {
      UI.showToast('Đã copy Markdown vào clipboard! 📝', 'success');
    }).catch(() => {
      UI.showToast('Không thể copy. Hãy thử lại.', 'error');
    });
  }

  // ═══════════════════════════════════════
  // DRAG & DROP
  // ═══════════════════════════════════════
  function setupDragDrop() {
    const zone = DOM.uploadZone;

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });

    zone.addEventListener('dragleave', () => {
      zone.classList.remove('drag-over');
    });

    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) {
        handleFileSelect(e.dataTransfer.files[0]);
      }
    });
  }

  // ═══════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════
  async function init() {
    cacheDOMRefs();

    // Restore saved API key
    const savedKey = await StorageHelper.get('gemini_api_key');
    if (savedKey) {
      DOM.apiKey.value = savedKey;
    }

    // ── Event Listeners ──
    // File input
    DOM.fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) {
        handleFileSelect(e.target.files[0]);
      }
    });

    // API Key change → update button
    DOM.apiKey.addEventListener('input', () => UI.updateSubmitButton());

    // Submit
    DOM.btnSubmit.addEventListener('click', handleSubmit);

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => UI.activateTab(btn.dataset.tab));
    });

    // Copy & Export
    DOM.btnCopy.addEventListener('click', handleCopySummary);
    DOM.btnMarkdown.addEventListener('click', handleExportMarkdown);

    // Drag & Drop
    setupDragDrop();

    // Initial button state
    UI.updateSubmitButton();
  }

  // ── Bootstrap ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Public API (for debugging/testing)
  return { State, Config, API, UI, StorageHelper };
})();
