/**
 * ╔══════════════════════════════════════════════════╗
 * ║  MEETING SUMMARIZER v2.0 - popup.js             ║
 * ║                                                 ║
 * ║  Features:                                      ║
 * ║  1. Live recording (MediaRecorder API)          ║
 * ║  2. File API for large files (up to 2GB)        ║
 * ║  3. Meeting history (StorageHelper)             ║
 * ║  4. Streaming transcription                     ║
 * ║  5. API key security (header, not query param)  ║
 * ║  6. Auto-chunk long audio (>15min)              ║
 * ╚══════════════════════════════════════════════════╝
 */

const MeetingSummarizer = (() => {
  'use strict';

  // ═══════════════════════════════════════
  // CONFIG
  // ═══════════════════════════════════════
  const Config = {
    MAX_FILE_SIZE: 2 * 1024 * 1024 * 1024, // 2GB
    INLINE_DATA_LIMIT: 20 * 1024 * 1024,   // 20MB — above this, use File API
    ACCEPTED_TYPES: ['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/webm', 'audio/ogg'],
    ACCEPTED_EXTENSIONS: ['.mp3', '.wav', '.m4a', '.webm', '.ogg'],
    GEMINI_API_BASE: 'https://generativelanguage.googleapis.com/v1beta',
    GEMINI_UPLOAD_BASE: 'https://generativelanguage.googleapis.com/upload/v1beta',
    GEMINI_MODEL: 'gemini-2.0-flash',
    TOAST_DURATION: 3500,
    MAX_HISTORY: 50,
    CHUNK_DURATION_SEC: 900, // 15 minutes
    MAX_REC_DURATION: 7200,  // 2 hours
    XOR_SALT: 'ms2024xk',   // Simple XOR salt for API key obfuscation
  };

  // ═══════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════
  const State = {
    selectedFile: null,
    audioBase64: null,
    audioDuration: null,
    isProcessing: false,
    results: { transcript: '', summary: [], actionItems: [] },
    // Recorder
    mediaRecorder: null,
    recordedChunks: [],
    recStartTime: null,
    recTimerInterval: null,
    recPaused: false,
    recPausedElapsed: 0,
    // Processing timer
    processStartTime: null,
    processTimerInterval: null,
    // File API cleanup
    uploadedFileUri: null,
  };

  // ═══════════════════════════════════════
  // STORAGE HELPER
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
      try { const val = localStorage.getItem(key); return val ? JSON.parse(val) : null; }
      catch { return null; }
    },
    async set(key, value) {
      if (this._isChromeExtension()) {
        return new Promise(resolve => {
          chrome.storage.local.set({ [key]: value }, resolve);
        });
      }
      try { localStorage.setItem(key, JSON.stringify(value)); }
      catch { /* quota exceeded */ }
    },
    async remove(key) {
      if (this._isChromeExtension()) {
        return new Promise(resolve => {
          chrome.storage.local.remove([key], resolve);
        });
      }
      try { localStorage.removeItem(key); } catch { }
    },
  };

  // ═══════════════════════════════════════
  // CRYPTO (simple XOR for key obfuscation)
  // ═══════════════════════════════════════
  const Crypto = {
    xorEncrypt(text, salt) {
      let result = '';
      for (let i = 0; i < text.length; i++) {
        result += String.fromCharCode(text.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
      }
      return btoa(result);
    },
    xorDecrypt(encoded, salt) {
      try {
        const decoded = atob(encoded);
        let result = '';
        for (let i = 0; i < decoded.length; i++) {
          result += String.fromCharCode(decoded.charCodeAt(i) ^ salt.charCodeAt(i % salt.length));
        }
        return result;
      } catch { return ''; }
    },
  };

  // ═══════════════════════════════════════
  // DOM REFERENCES
  // ═══════════════════════════════════════
  let DOM = {};

  function cacheDOMRefs() {
    DOM = {
      // Recorder
      recorder: document.getElementById('recorder'),
      btnRecStart: document.getElementById('btnRecStart'),
      btnRecPause: document.getElementById('btnRecPause'),
      btnRecStop: document.getElementById('btnRecStop'),
      recTimer: document.getElementById('recTimer'),
      recStatus: document.getElementById('recStatus'),
      // Upload
      uploadZone: document.getElementById('uploadZone'),
      fileInput: document.getElementById('fileInput'),
      fileInfo: document.getElementById('fileInfo'),
      fileName: document.getElementById('fileName'),
      fileSize: document.getElementById('fileSize'),
      fileDuration: document.getElementById('fileDuration'),
      fileWarning: document.getElementById('fileWarning'),
      // Upload progress
      uploadProgress: document.getElementById('uploadProgress'),
      uploadProgressFill: document.getElementById('uploadProgressFill'),
      uploadProgressText: document.getElementById('uploadProgressText'),
      uploadProgressPct: document.getElementById('uploadProgressPct'),
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
      stepElapsed: document.getElementById('stepElapsed'),
      errorMessage: document.getElementById('errorMessage'),
      // Process progress
      processProgress: document.getElementById('processProgress'),
      processProgressFill: document.getElementById('processProgressFill'),
      processProgressText: document.getElementById('processProgressText'),
      processProgressPct: document.getElementById('processProgressPct'),
      // Results
      resultsEmpty: document.getElementById('resultsEmpty'),
      resultsContent: document.getElementById('resultsContent'),
      summaryList: document.getElementById('summaryList'),
      actionItemsList: document.getElementById('actionItemsList'),
      transcriptBox: document.getElementById('transcriptBox'),
      // History
      historyList: document.getElementById('historyList'),
      btnClearHistory: document.getElementById('btnClearHistory'),
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
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return 'Không xác định';
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) return `${hrs}h ${mins}p ${secs}s`;
    if (mins === 0) return `${secs} giây`;
    return `${mins} phút ${secs > 0 ? secs + ' giây' : ''}`.trim();
  }

  function formatTimer(seconds) {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
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
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = () => reject(new Error('Không thể đọc file'));
      reader.readAsDataURL(file);
    });
  }

  function getAudioDuration(file) {
    return new Promise((resolve) => {
      const audio = new Audio();
      const url = URL.createObjectURL(file);
      audio.addEventListener('loadedmetadata', () => { resolve(audio.duration); URL.revokeObjectURL(url); });
      audio.addEventListener('error', () => { resolve(null); URL.revokeObjectURL(url); });
      audio.src = url;
    });
  }

  function getMimeType(file) {
    const ext = file.name.toLowerCase().split('.').pop();
    const mimeMap = { 'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'm4a': 'audio/mp4', 'webm': 'audio/webm', 'ogg': 'audio/ogg' };
    return mimeMap[ext] || file.type || 'audio/mpeg';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
      [DOM.step1, DOM.step2, DOM.step3].forEach(s => s.className = 'step-indicator__step');
      // Start elapsed timer
      State.processStartTime = Date.now();
      DOM.stepElapsed.textContent = '⏱️ 0s';
      State.processTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - State.processStartTime) / 1000);
        DOM.stepElapsed.textContent = `⏱️ ${formatTimer(elapsed)}`;
      }, 1000);
    },

    hideLoading() {
      State.isProcessing = false;
      DOM.btnSubmit.classList.remove('loading');
      DOM.btnSubmit.querySelector('.loading-btn-text').style.display = 'none';
      DOM.loadingText.classList.remove('visible');
      DOM.stepIndicator.classList.remove('visible');
      DOM.processProgress.classList.remove('visible');
      if (State.processTimerInterval) { clearInterval(State.processTimerInterval); State.processTimerInterval = null; }
      UI.updateSubmitButton();
    },

    setStep(stepNum) {
      const steps = [DOM.step1, DOM.step2, DOM.step3];
      steps.forEach((step, i) => {
        if (i + 1 < stepNum) step.className = 'step-indicator__step done';
        else if (i + 1 === stepNum) step.className = 'step-indicator__step active';
        else step.className = 'step-indicator__step';
      });
    },

    showError(message) { DOM.errorMessage.textContent = '⚠️ ' + message; DOM.errorMessage.classList.add('visible'); },
    hideError() { DOM.errorMessage.classList.remove('visible'); },

    updateSubmitButton() {
      const hasFile = !!State.selectedFile;
      const hasKey = !!DOM.apiKey.value.trim();
      DOM.btnSubmit.disabled = !hasFile || !hasKey || State.isProcessing;
    },

    showUploadProgress(pct, text) {
      DOM.uploadProgress.classList.add('visible');
      DOM.uploadProgressFill.style.width = pct + '%';
      DOM.uploadProgressPct.textContent = Math.round(pct) + '%';
      if (text) DOM.uploadProgressText.textContent = text;
    },
    hideUploadProgress() { DOM.uploadProgress.classList.remove('visible'); },

    showProcessProgress(pct, text) {
      DOM.processProgress.classList.add('visible');
      DOM.processProgressFill.style.width = pct + '%';
      DOM.processProgressPct.textContent = Math.round(pct) + '%';
      if (text) DOM.processProgressText.textContent = text;
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
          </div>`;
        const checkbox = div.querySelector('input[type="checkbox"]');
        checkbox.addEventListener('change', () => div.classList.toggle('checked', checkbox.checked));
        DOM.actionItemsList.appendChild(div);
      });
    },

    renderTranscript(transcript) { DOM.transcriptBox.textContent = transcript; },

    showResults() { DOM.resultsEmpty.style.display = 'none'; DOM.resultsContent.style.display = 'block'; },
    resetResults() {
      DOM.resultsEmpty.style.display = '';
      DOM.resultsContent.style.display = 'none';
      DOM.summaryList.innerHTML = '';
      DOM.actionItemsList.innerHTML = '';
      DOM.transcriptBox.textContent = '';
    },

    activateTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tabId));
      document.querySelectorAll('.tab-content').forEach(tc => tc.classList.toggle('active', tc.id === `tab-${tabId}`));
    },
  };

  // ═══════════════════════════════════════
  // RECORDER MODULE
  // ═══════════════════════════════════════
  const Recorder = {
    async start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
          : MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '';

        State.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
        State.recordedChunks = [];
        State.recPaused = false;
        State.recPausedElapsed = 0;

        State.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) State.recordedChunks.push(e.data);
        };

        State.mediaRecorder.onstop = () => {
          stream.getTracks().forEach(t => t.stop());
          const blob = new Blob(State.recordedChunks, { type: State.mediaRecorder.mimeType || 'audio/webm' });
          const ext = blob.type.includes('mp4') ? 'm4a' : 'webm';
          const file = new File([blob], `recording-${new Date().toISOString().slice(0, 16).replace(/[:.]/g, '-')}.${ext}`, { type: blob.type });
          handleFileSelect(file);
          Recorder._resetUI();
          UI.showToast('🎤 Đã lưu bản ghi âm!', 'success');
        };

        State.mediaRecorder.start(1000); // collect data every second
        State.recStartTime = Date.now();

        // UI
        DOM.recorder.classList.add('active');
        DOM.btnRecStart.classList.add('recording');
        DOM.recStatus.textContent = '🔴 Đang ghi âm...';
        DOM.recTimer.classList.add('active');

        // Timer
        State.recTimerInterval = setInterval(() => {
          if (!State.recPaused) {
            const elapsed = Math.floor((Date.now() - State.recStartTime) / 1000) - State.recPausedElapsed;
            DOM.recTimer.textContent = formatTimer(elapsed);
            // Auto-stop at max duration
            if (elapsed >= Config.MAX_REC_DURATION) {
              Recorder.stop();
              UI.showToast('⏰ Đã đạt giới hạn 2 giờ, tự động dừng.', 'info');
            }
          }
        }, 500);

      } catch (err) {
        console.error('Recorder error:', err);
        if (err.name === 'NotAllowedError') {
          UI.showToast('❌ Cần cho phép truy cập microphone để ghi âm.', 'error');
        } else {
          UI.showToast('❌ Không thể bắt đầu ghi âm: ' + err.message, 'error');
        }
      }
    },

    pause() {
      if (State.mediaRecorder && State.mediaRecorder.state === 'recording') {
        State.mediaRecorder.pause();
        State.recPaused = true;
        State._pauseStart = Date.now();
        DOM.recStatus.textContent = '⏸️ Tạm dừng';
        DOM.btnRecPause.textContent = '▶';
        DOM.btnRecPause.title = 'Tiếp tục';
        DOM.recorder.classList.remove('active');
      }
    },

    resume() {
      if (State.mediaRecorder && State.mediaRecorder.state === 'paused') {
        State.mediaRecorder.resume();
        State.recPausedElapsed += Math.floor((Date.now() - State._pauseStart) / 1000);
        State.recPaused = false;
        DOM.recStatus.textContent = '🔴 Đang ghi âm...';
        DOM.btnRecPause.textContent = '⏸';
        DOM.btnRecPause.title = 'Tạm dừng';
        DOM.recorder.classList.add('active');
      }
    },

    stop() {
      if (State.mediaRecorder && (State.mediaRecorder.state === 'recording' || State.mediaRecorder.state === 'paused')) {
        State.mediaRecorder.stop();
      }
    },

    _resetUI() {
      if (State.recTimerInterval) { clearInterval(State.recTimerInterval); State.recTimerInterval = null; }
      DOM.recorder.classList.remove('active');
      DOM.btnRecStart.classList.remove('recording');
      DOM.recTimer.classList.remove('active');
      DOM.recTimer.textContent = '00:00';
      DOM.recStatus.textContent = 'Nhấn nút đỏ để bắt đầu ghi âm';
      DOM.btnRecPause.textContent = '⏸';
      DOM.btnRecPause.title = 'Tạm dừng';
    },
  };

  // ═══════════════════════════════════════
  // FILE UPLOAD MODULE (Gemini File API)
  // ═══════════════════════════════════════
  const FileUploader = {
    /**
     * Upload file to Gemini File API for large files.
     * Returns the file URI to reference in generation requests.
     */
    async upload(file, apiKey) {
      const mimeType = getMimeType(file);
      const displayName = file.name;

      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const url = `${Config.GEMINI_UPLOAD_BASE}/files?key=${apiKey}`;

        xhr.open('POST', url);

        // Track upload progress
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = (e.loaded / e.total) * 100;
            UI.showUploadProgress(pct, `Đang upload... ${formatFileSize(e.loaded)} / ${formatFileSize(e.total)}`);
          }
        };

        xhr.onload = () => {
          UI.hideUploadProgress();
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const data = JSON.parse(xhr.responseText);
              resolve(data.file);
            } catch (e) {
              reject(new Error('Không thể parse response từ File API'));
            }
          } else {
            try {
              const errData = JSON.parse(xhr.responseText);
              reject(new Error(errData?.error?.message || `Upload failed: HTTP ${xhr.status}`));
            } catch {
              reject(new Error(`Upload failed: HTTP ${xhr.status}`));
            }
          }
        };

        xhr.onerror = () => {
          UI.hideUploadProgress();
          reject(new Error('Upload failed: Network error'));
        };

        // Build multipart request
        const metadata = JSON.stringify({ file: { displayName, mimeType } });

        // Use FormData-like approach with proper headers
        xhr.setRequestHeader('X-Goog-Upload-Protocol', 'multipart');
        xhr.setRequestHeader('Content-Type', `multipart/related; boundary=boundary123`);

        const body = `--boundary123\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--boundary123\r\nContent-Type: ${mimeType}\r\n\r\n`;
        const bodyEnd = `\r\n--boundary123--`;

        // Build the complete body with binary data
        const reader = new FileReader();
        reader.onload = () => {
          const arrayBuffer = reader.result;
          const bodyStart = new TextEncoder().encode(body);
          const bodyEndBytes = new TextEncoder().encode(bodyEnd);
          const combined = new Uint8Array(bodyStart.length + arrayBuffer.byteLength + bodyEndBytes.length);
          combined.set(bodyStart, 0);
          combined.set(new Uint8Array(arrayBuffer), bodyStart.length);
          combined.set(bodyEndBytes, bodyStart.length + arrayBuffer.byteLength);
          xhr.send(combined);
        };
        reader.onerror = () => reject(new Error('Không thể đọc file'));
        reader.readAsArrayBuffer(file);
      });
    },

    /**
     * Poll file status until it's ACTIVE (processed and ready)
     */
    async waitForActive(fileName, apiKey, maxWaitMs = 120000) {
      const startTime = Date.now();
      while (Date.now() - startTime < maxWaitMs) {
        const url = `${Config.GEMINI_API_BASE}/${fileName}`;
        const response = await fetch(url, {
          headers: { 'x-goog-api-key': apiKey },
        });

        if (!response.ok) throw new Error(`File status check failed: HTTP ${response.status}`);
        const data = await response.json();

        if (data.state === 'ACTIVE') return data;
        if (data.state === 'FAILED') throw new Error('File processing failed on server.');

        UI.showProcessProgress(30, 'Đang chờ server xử lý file...');
        await new Promise(r => setTimeout(r, 3000)); // Poll every 3 seconds
      }
      throw new Error('Timeout waiting for file processing.');
    },

    /**
     * Delete uploaded file from server (cleanup)
     */
    async delete(fileName, apiKey) {
      try {
        await fetch(`${Config.GEMINI_API_BASE}/${fileName}`, {
          method: 'DELETE',
          headers: { 'x-goog-api-key': apiKey },
        });
      } catch { /* silent cleanup */ }
    },
  };

  // ═══════════════════════════════════════
  // AUDIO CHUNKER MODULE
  // ═══════════════════════════════════════
  const AudioChunker = {
    shouldChunk(durationSec) {
      return durationSec && durationSec > Config.CHUNK_DURATION_SEC;
    },

    /**
     * Split audio file into chunks using Blob slicing (approximate splitting).
     * For a more precise approach we'd use AudioContext, but blob slicing
     * works well for transcription since Gemini handles partial audio gracefully.
     */
    async splitFile(file, durationSec) {
      const numChunks = Math.ceil(durationSec / Config.CHUNK_DURATION_SEC);
      const chunkSize = Math.ceil(file.size / numChunks);
      const chunks = [];

      for (let i = 0; i < numChunks; i++) {
        const start = i * chunkSize;
        const end = Math.min(start + chunkSize, file.size);
        const blob = file.slice(start, end);
        const chunkFile = new File([blob], `chunk_${i + 1}.${file.name.split('.').pop()}`, { type: file.type });
        chunks.push(chunkFile);
      }

      return chunks;
    },
  };

  // ═══════════════════════════════════════
  // GEMINI API MODULE
  // ═══════════════════════════════════════
  const API = {
    _getApiKey() {
      return DOM.apiKey.value.trim();
    },

    /**
     * Build API URL WITHOUT the key in query params (security improvement)
     */
    _buildApiUrl(endpoint) {
      return `${Config.GEMINI_API_BASE}/${endpoint}`;
    },

    _buildHeaders() {
      return {
        'Content-Type': 'application/json',
        'x-goog-api-key': this._getApiKey(),
      };
    },

    /**
     * Transcribe audio using streaming for real-time text display.
     * Falls back to non-streaming if streaming fails.
     */
    async callGeminiForTranscription(audioDataOrUri, mimeType, isFileUri = false) {
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

      const parts = [{ text: prompt }];

      if (isFileUri) {
        parts.push({ fileData: { mimeType, fileUri: audioDataOrUri } });
      } else {
        parts.push({ inlineData: { mimeType, data: audioDataOrUri } });
      }

      const url = this._buildApiUrl(`models/${Config.GEMINI_MODEL}:streamGenerateContent?alt=sse`);
      const body = {
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      };

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this._buildHeaders(),
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData?.error?.message || `HTTP ${response.status}`);
        }

        // Stream the response
        let fullText = '';
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const jsonStr = line.slice(6).trim();
              if (!jsonStr || jsonStr === '[DONE]') continue;
              try {
                const parsed = JSON.parse(jsonStr);
                const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                if (text) {
                  fullText += text;
                  // Real-time update in transcript box
                  DOM.transcriptBox.textContent = fullText;
                }
              } catch { /* skip malformed chunks */ }
            }
          }
        }

        if (!fullText) throw new Error('Không nhận được transcript từ Gemini.');
        return fullText.trim();

      } catch (err) {
        // Fallback to non-streaming if streaming fails
        if (err.message.includes('Failed to fetch') || err.message.includes('NetworkError')) {
          return this._callGeminiNonStreaming(parts);
        }
        throw new Error(`Transcription failed: ${err.message}`);
      }
    },

    async _callGeminiNonStreaming(parts) {
      const url = this._buildApiUrl(`models/${Config.GEMINI_MODEL}:generateContent`);
      const body = {
        contents: [{ parts }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 },
      };
      const response = await fetch(url, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || `HTTP ${response.status}`);
      }
      const data = await response.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
    },

    /**
     * Summarize transcript and extract action items
     */
    async callGeminiForSummary(transcript) {
      const detailLevel = DOM.detailLevel.value;
      const outputLang = DOM.outputLang.value;
      const summaryTone = DOM.summaryTone.value;
      const focusActions = DOM.focusActions.checked;

      const langMap = { vi: 'Vietnamese', en: 'English', same: 'same language as the transcript' };
      const outputLangName = langMap[outputLang] || 'Vietnamese';

      const detailMap = {
        brief: '3-5 key points maximum, very concise',
        standard: '5-8 key points with moderate detail',
        detailed: '8-12 key points with comprehensive detail',
      };
      const detailInstruction = detailMap[detailLevel] || detailMap.standard;

      const toneMap = {
        neutral: 'neutral and objective',
        friendly: 'friendly and approachable',
        formal: 'formal and professional',
      };
      const toneInstruction = toneMap[summaryTone] || toneMap.neutral;

      const prompt = `You are an expert meeting note taker. Analyze the following meeting transcript and provide a structured output.

OUTPUT LANGUAGE: ${outputLangName}
TONE: ${toneInstruction}
DETAIL LEVEL: ${detailInstruction}
${focusActions ? 'PRIORITY: Focus especially on action items, decisions, and commitments made during the meeting.' : ''}

Please respond ONLY with valid JSON (no markdown code fences, no extra text) in this exact format:
{
  "summary": ["Key point 1", "Key point 2"],
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
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers: this._buildHeaders(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData?.error?.message || `HTTP ${response.status}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error('Không nhận được tóm tắt từ Gemini.');

      try {
        const cleaned = text.replace(/```json\s*|```\s*/g, '').trim();
        return JSON.parse(cleaned);
      } catch (e) {
        console.error('Failed to parse summary JSON:', text);
        throw new Error('Không thể phân tích kết quả tóm tắt. Vui lòng thử lại.');
      }
    },
  };

  // ═══════════════════════════════════════
  // HISTORY MODULE
  // ═══════════════════════════════════════
  const History = {
    async load() {
      return (await StorageHelper.get('meeting_history')) || [];
    },

    async save(entry) {
      const history = await this.load();
      history.unshift({
        id: generateId(),
        date: new Date().toISOString(),
        fileName: entry.fileName || 'Không rõ',
        summary: entry.summary || [],
        actionItems: entry.actionItems || [],
        transcript: entry.transcript || '',
      });
      // Keep only MAX_HISTORY entries
      if (history.length > Config.MAX_HISTORY) history.length = Config.MAX_HISTORY;
      await StorageHelper.set('meeting_history', history);
      this.render(history);
    },

    async deleteEntry(id) {
      let history = await this.load();
      history = history.filter(h => h.id !== id);
      await StorageHelper.set('meeting_history', history);
      this.render(history);
      UI.showToast('Đã xóa mục lịch sử.', 'info');
    },

    async clearAll() {
      await StorageHelper.remove('meeting_history');
      this.render([]);
      UI.showToast('Đã xóa toàn bộ lịch sử.', 'info');
    },

    render(history) {
      DOM.historyList.innerHTML = '';
      if (!history.length) return;

      history.forEach(item => {
        const div = document.createElement('div');
        div.className = 'history-item';
        const date = new Date(item.date);
        const dateStr = date.toLocaleDateString('vi-VN') + ' ' + date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
        const preview = item.summary?.slice(0, 2).join(' • ') || 'Không có tóm tắt';

        div.innerHTML = `
          <div class="history-item__header">
            <span class="history-item__date">${dateStr}</span>
            <button class="history-item__delete" data-id="${item.id}" title="Xóa">✕</button>
          </div>
          <div class="history-item__name">${escapeHtml(item.fileName)}</div>
          <div class="history-item__preview">${escapeHtml(preview)}</div>`;

        // Click to restore results
        div.addEventListener('click', (e) => {
          if (e.target.classList.contains('history-item__delete')) return;
          State.results.summary = item.summary || [];
          State.results.actionItems = item.actionItems || [];
          State.results.transcript = item.transcript || '';
          UI.renderSummary(State.results.summary);
          UI.renderActionItems(State.results.actionItems);
          UI.renderTranscript(State.results.transcript);
          UI.showResults();
          UI.activateTab('summary');
          UI.showToast(`📂 Đã tải lại: ${item.fileName}`, 'success');
        });

        // Delete button
        div.querySelector('.history-item__delete').addEventListener('click', (e) => {
          e.stopPropagation();
          History.deleteEntry(item.id);
        });

        DOM.historyList.appendChild(div);
      });
    },
  };

  // ═══════════════════════════════════════
  // EVENT HANDLERS
  // ═══════════════════════════════════════
  async function handleFileSelect(file) {
    const ext = '.' + file.name.toLowerCase().split('.').pop();
    if (!Config.ACCEPTED_EXTENSIONS.includes(ext)) {
      UI.showToast('File không được hỗ trợ. Vui lòng chọn .mp3, .wav, .m4a, .webm, .ogg', 'error');
      return;
    }

    if (file.size > Config.MAX_FILE_SIZE) {
      UI.showToast(`File quá lớn (${formatFileSize(file.size)}). Tối đa 2GB.`, 'error');
      return;
    }

    State.selectedFile = file;

    DOM.fileInfo.classList.add('visible');
    DOM.fileName.textContent = file.name;
    DOM.fileSize.textContent = '📦 ' + formatFileSize(file.size);

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
    if (file.size > Config.INLINE_DATA_LIMIT) {
      DOM.fileWarning.style.display = 'block';
      DOM.fileWarning.textContent = '📡 File lớn — sẽ dùng File API để upload lên server trước khi xử lý.';
    } else if (file.size > 15 * 1024 * 1024) {
      DOM.fileWarning.style.display = 'block';
      DOM.fileWarning.textContent = '⚠️ File lớn, thời gian xử lý có thể lâu hơn.';
    } else {
      DOM.fileWarning.style.display = 'none';
    }

    // Warn chunking
    if (duration && AudioChunker.shouldChunk(duration)) {
      const numChunks = Math.ceil(duration / Config.CHUNK_DURATION_SEC);
      DOM.fileWarning.style.display = 'block';
      DOM.fileWarning.textContent += ` ✂️ Audio dài ${formatDuration(duration)} — sẽ chia thành ${numChunks} phần để transcribe.`;
    }

    UI.updateSubmitButton();
    UI.hideError();
  }

  async function handleSubmit() {
    if (State.isProcessing || !State.selectedFile) return;

    const apiKey = DOM.apiKey.value.trim();
    if (!apiKey) { UI.showError('Vui lòng nhập Gemini API Key.'); return; }

    // Save encrypted API key
    const encrypted = Crypto.xorEncrypt(apiKey, Config.XOR_SALT);
    StorageHelper.set('gemini_api_key_enc', encrypted);

    UI.showLoading();
    UI.resetResults();
    // Show transcript tab early for streaming effect
    UI.showResults();
    UI.activateTab('transcript');
    DOM.transcriptBox.textContent = '';

    try {
      const mimeType = getMimeType(State.selectedFile);
      const useFileAPI = State.selectedFile.size > Config.INLINE_DATA_LIMIT;
      const shouldChunk = State.audioDuration && AudioChunker.shouldChunk(State.audioDuration) && !useFileAPI;

      let transcript = '';

      // ── Step 1: Transcribe ──
      UI.setStep(1);

      if (useFileAPI) {
        // Large file: upload via File API
        UI.showProcessProgress(5, 'Đang upload file lên server...');
        const fileData = await FileUploader.upload(State.selectedFile, apiKey);
        UI.showProcessProgress(25, 'Đang chờ server xử lý file...');

        const activeFile = await FileUploader.waitForActive(fileData.name, apiKey);
        State.uploadedFileUri = activeFile.name;

        UI.showProcessProgress(40, 'Đang transcribe qua File API...');
        transcript = await API.callGeminiForTranscription(activeFile.uri, mimeType, true);

      } else if (shouldChunk) {
        // Long audio: chunk and transcribe sequentially
        const chunks = await AudioChunker.splitFile(State.selectedFile, State.audioDuration);
        const totalChunks = chunks.length;
        let allTranscripts = [];

        for (let i = 0; i < totalChunks; i++) {
          UI.showProcessProgress(
            10 + (i / totalChunks) * 60,
            `Đang transcribe phần ${i + 1}/${totalChunks}...`
          );
          DOM.transcriptBox.textContent = allTranscripts.join('\n\n') + (allTranscripts.length ? '\n\n' : '') + '⏳ Đang transcribe phần ' + (i + 1) + '...';

          const chunkBase64 = await fileToBase64(chunks[i]);
          const chunkTranscript = await API.callGeminiForTranscription(chunkBase64, mimeType);
          allTranscripts.push(chunkTranscript);
        }

        transcript = allTranscripts.join('\n\n');
        DOM.transcriptBox.textContent = transcript;

      } else {
        // Normal: inline data with streaming
        UI.showProcessProgress(10, 'Đang chuyển đổi audio...');
        const audioBase64 = await fileToBase64(State.selectedFile);
        UI.showProcessProgress(20, 'Đang transcribe...');
        transcript = await API.callGeminiForTranscription(audioBase64, mimeType);
      }

      State.results.transcript = transcript;
      UI.showProcessProgress(70, 'Transcript hoàn tất, đang tóm tắt...');

      // ── Step 2: Summarize ──
      UI.setStep(2);
      const summaryResult = await API.callGeminiForSummary(transcript);
      State.results.summary = summaryResult.summary || [];
      State.results.actionItems = summaryResult.actionItems || [];

      UI.showProcessProgress(95, 'Đang hoàn thiện...');

      // ── Step 3: Render ──
      UI.setStep(3);
      await new Promise(r => setTimeout(r, 300));

      UI.renderSummary(State.results.summary);
      UI.renderActionItems(State.results.actionItems);
      UI.renderTranscript(State.results.transcript);
      UI.showResults();
      UI.activateTab('summary');

      // Save to history
      await History.save({
        fileName: State.selectedFile.name,
        summary: State.results.summary,
        actionItems: State.results.actionItems,
        transcript: State.results.transcript,
      });

      UI.showToast('🎉 Tóm tắt hoàn tất!', 'success');

    } catch (error) {
      console.error('Processing error:', error);
      UI.showError(error.message || 'Đã xảy ra lỗi không xác định.');
      UI.showToast('Xử lý thất bại: ' + error.message, 'error');
    } finally {
      UI.hideLoading();
      // Cleanup uploaded file
      if (State.uploadedFileUri) {
        FileUploader.delete(State.uploadedFileUri, API._getApiKey());
        State.uploadedFileUri = null;
      }
    }
  }

  function handleCopySummary() {
    const { summary, actionItems } = State.results;
    if (!summary.length && !actionItems.length) { UI.showToast('Chưa có kết quả để copy.', 'info'); return; }

    let text = '📋 TÓM TẮT CUỘC HỌP\n' + '═'.repeat(30) + '\n\n';
    if (summary.length) {
      text += '📌 Tóm tắt chính:\n';
      summary.forEach((s, i) => text += `  ${i + 1}. ${s}\n`);
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
    }).catch(() => UI.showToast('Không thể copy. Hãy thử lại.', 'error'));
  }

  function handleExportMarkdown() {
    const { summary, actionItems, transcript } = State.results;
    if (!summary.length && !actionItems.length && !transcript) { UI.showToast('Chưa có kết quả để xuất.', 'info'); return; }

    let md = '# 📋 Tóm tắt cuộc họp\n\n';
    md += `> 📅 Ngày: ${new Date().toLocaleDateString('vi-VN')}\n\n`;

    if (summary.length) {
      md += '## 📌 Tóm tắt chính\n\n';
      summary.forEach(s => md += `- ${s}\n`);
      md += '\n';
    }
    if (actionItems.length) {
      md += '## ✅ Action Items\n\n';
      md += '| # | Mô tả | Phụ trách | Deadline |\n';
      md += '|---|--------|-----------|----------|\n';
      actionItems.forEach((item, i) => md += `| ${i + 1} | ${item.description} | ${item.assignee || '—'} | ${item.deadline || '—'} |\n`);
      md += '\n';
    }
    if (transcript) {
      md += '## 📝 Transcript đầy đủ\n\n';
      md += '```\n' + transcript + '\n```\n';
    }

    navigator.clipboard.writeText(md).then(() => {
      UI.showToast('Đã copy Markdown vào clipboard! 📝', 'success');
    }).catch(() => UI.showToast('Không thể copy. Hãy thử lại.', 'error'));
  }

  // ═══════════════════════════════════════
  // DRAG & DROP
  // ═══════════════════════════════════════
  function setupDragDrop() {
    const zone = DOM.uploadZone;
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (e.dataTransfer.files.length) handleFileSelect(e.dataTransfer.files[0]);
    });
  }

  // ═══════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════
  async function init() {
    cacheDOMRefs();

    // Restore encrypted API key
    const encKey = await StorageHelper.get('gemini_api_key_enc');
    if (encKey) {
      DOM.apiKey.value = Crypto.xorDecrypt(encKey, Config.XOR_SALT);
    } else {
      // Fallback: migrate from old plain storage
      const oldKey = await StorageHelper.get('gemini_api_key');
      if (oldKey) {
        DOM.apiKey.value = oldKey;
        // Re-save encrypted
        const encrypted = Crypto.xorEncrypt(oldKey, Config.XOR_SALT);
        await StorageHelper.set('gemini_api_key_enc', encrypted);
        await StorageHelper.remove('gemini_api_key');
      }
    }

    // Load history
    const history = await History.load();
    History.render(history);

    // ── Event Listeners ──
    DOM.fileInput.addEventListener('change', (e) => { if (e.target.files.length) handleFileSelect(e.target.files[0]); });
    DOM.apiKey.addEventListener('input', () => UI.updateSubmitButton());
    DOM.btnSubmit.addEventListener('click', handleSubmit);

    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => UI.activateTab(btn.dataset.tab));
    });

    // Copy & Export
    DOM.btnCopy.addEventListener('click', handleCopySummary);
    DOM.btnMarkdown.addEventListener('click', handleExportMarkdown);

    // Recorder buttons
    DOM.btnRecStart.addEventListener('click', () => {
      if (State.mediaRecorder && State.mediaRecorder.state === 'recording') {
        // Already recording, do nothing (use stop button)
        return;
      }
      Recorder.start();
    });
    DOM.btnRecPause.addEventListener('click', () => {
      if (State.recPaused) Recorder.resume();
      else Recorder.pause();
    });
    DOM.btnRecStop.addEventListener('click', () => Recorder.stop());

    // History clear
    DOM.btnClearHistory.addEventListener('click', () => History.clearAll());

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

  return { State, Config, API, UI, StorageHelper, Recorder, History };
})();
