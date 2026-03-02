// ═══════════════════════════════════════════════════════════════
// Impactable Market Analysis — Frontend Application
// ═══════════════════════════════════════════════════════════════

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────
  var CONFIG = {
    discoveryUrl: 'https://n8n.app.everythink.pro/webhook/feature-discovery',
    analysisUrl:  'https://n8n.app.everythink.pro/webhook/start-analysis',
    masterLogId:  '1JzJAaQsf7lZt9IYu0DjnYe3sadFjzc3NiuLHp_ZGypw',
    pollInterval: 8000,
    defaultEmail: 'branko.j.98@gmail.com',
    rateLimitMs:  30000  // min 30s between submits
  };

  // ─── State ────────────────────────────────────────────────
  var state = {
    phase: 'discover',       // discover | discovering | review | submitting | running | complete
    clientName: '',
    homepageUrl: '',
    userEmail: '',
    coreDesc: '',
    features: [],            // [{id, name, url, short_description, type, selected, parent, custom}]
    runId: '',
    sheetUrl: '',
    events: [],              // parsed from Master Log
    totalFeatures: 0,
    pollTimer: null,
    pollError: false,
    lastSubmitTime: 0
  };

  // ─── DOM References ───────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };

  var dom = {};
  function cacheDom() {
    dom.stepper      = $('stepper');
    dom.errorBanner  = $('error-banner');
    dom.errorText    = $('error-text');
    dom.phaseDiscover = $('phase-discover');
    dom.phaseReview   = $('phase-review');
    dom.phaseStatus   = $('phase-status');

    // Discovery
    dom.dForm    = $('discover-form');
    dom.dName    = $('d-name');
    dom.dUrl     = $('d-url');
    dom.dEmail   = $('d-email');
    dom.dCompany = $('d-company'); // honeypot
    dom.dSubmit  = $('d-submit');
    dom.dHint    = $('d-hint');

    // Review
    dom.rClient   = $('r-client');
    dom.rUrl      = $('r-url');
    dom.rDesc     = $('r-desc');
    dom.rCount    = $('r-count');
    dom.rList     = $('features-list');
    dom.rAdd      = $('r-add');
    dom.rBack     = $('r-back');
    dom.rSubmit   = $('r-submit');

    // Status
    dom.sComplete    = $('s-complete');
    dom.sCompleteMsg = $('s-complete-msg');
    dom.sAlertBadges = $('s-alert-badges');
    dom.sSheetLink   = $('s-sheet-link');
    dom.sSheetUrl    = $('s-sheet-url');
    dom.sProgress    = $('s-progress');
    dom.sProgressCnt = $('s-progress-count');
    dom.sProgressFill = $('s-progress-fill');
    dom.eventsList   = $('events-list');
    dom.evtEmpty     = $('evt-empty');
    dom.sPolling     = $('s-polling');
    dom.sPollDot     = $('s-poll-dot');
    dom.sPollText    = $('s-poll-text');
    dom.sNewrun      = $('s-newrun');
    dom.sReset       = $('s-reset');
  }


  // ─── Utilities ────────────────────────────────────────────

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  function showError(msg) {
    dom.errorText.textContent = msg;
    show(dom.errorBanner);
  }
  function hideError() { hide(dom.errorBanner); }

  function setDisabled(el, val) { el.disabled = val; }

  // Get Turnstile token (returns empty string if widget not loaded)
  function getTurnstileToken() {
    if (typeof turnstile !== 'undefined') {
      var token = turnstile.getResponse();
      return token || '';
    }
    return '';
  }

  function resetTurnstile() {
    if (typeof turnstile !== 'undefined') {
      turnstile.reset();
    }
  }

  // Parse Google Sheets gviz response
  function parseGviz(text) {
    try {
      var match = text.match(/setResponse\(([\s\S]+)\)\s*;?\s*$/);
      var json;
      if (match) {
        json = JSON.parse(match[1]);
      } else {
        // Fallback: strip wrapper
        json = JSON.parse(text.replace(/^[^(]*\(/, '').replace(/\);?\s*$/, ''));
      }
      if (!json.table || !json.table.rows) return [];
      return json.table.rows.map(function (r) {
        var c = r.c || [];
        return {
          runId:     (c[0] && c[0].v) || '',
          timestamp: (c[1] && c[1].v) || '',
          feature:   (c[2] && c[2].v) || '',
          event:     (c[3] && c[3].v) || '',
          message:   (c[4] && c[4].v) || '',
          type:      (c[5] && c[5].v) || ''
        };
      });
    } catch (e) {
      return [];
    }
  }

  // Format gviz timestamp to HH:MM:SS
  function fmtTime(v) {
    if (!v) return '';
    try {
      // gviz Date() format
      if (typeof v === 'string' && v.indexOf('Date(') === 0) {
        var p = v.match(/Date\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
        if (p) {
          var d = new Date(+p[1], +p[2], +p[3], +p[4], +p[5], +p[6]);
          return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }
      }
      // ISO string
      var dt = new Date(v);
      if (isNaN(dt.getTime())) return '';
      return dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch (e) {
      return '';
    }
  }

  // Event type styling config
  var EVT_STYLES = {
    system:         { color: '#4c9acb', bg: '#4c9acb18', icon: '\u25C6' },
    progress:       { color: '#4c9acb', bg: '#4c9acb18', icon: '\u25B8' },
    alert_warning:  { color: '#f5a623', bg: '#2a1f0a',   icon: '\u25B2' },
    alert_critical: { color: '#ef4444', bg: '#2a0f0f',   icon: '\u2715' },
    complete:       { color: '#22c55e', bg: '#0d2818',   icon: '\u2713' }
  };

  // Simple unique ID
  var _idCounter = 0;
  function uid() { return 'f' + (++_idCounter) + '_' + Math.random().toString(36).substr(2, 5); }


  // ─── Stepper ──────────────────────────────────────────────

  // stepStates: 0=inactive, 1=active, 2=done
  function updateStepper(s0, s1, s2) {
    var states = [s0, s1, s2];
    show(dom.stepper);
    for (var i = 0; i < 3; i++) {
      var bar = $('step-bar-' + i);
      var lbl = $('step-lbl-' + i);
      bar.className = 'stepper-bar';
      lbl.className = 'stepper-label';
      if (states[i] === 2) { bar.classList.add('done'); lbl.classList.add('done'); }
      else if (states[i] === 1) { bar.classList.add('active'); lbl.classList.add('active'); }
    }
  }


  // ─── Phase Transitions ────────────────────────────────────

  function goDiscover() {
    state.phase = 'discover';
    hideError();
    hide(dom.stepper);
    show(dom.phaseDiscover);
    hide(dom.phaseReview);
    hide(dom.phaseStatus);
    hide(dom.dHint);
    dom.dSubmit.innerHTML = 'Discover Features';
    setDisabled(dom.dSubmit, false);
    setDisabled(dom.dName, false);
    setDisabled(dom.dUrl, false);
    setDisabled(dom.dEmail, false);
    validateDiscoverForm();
  }

  function goDiscovering() {
    state.phase = 'discovering';
    hideError();
    updateStepper(1, 0, 0);
    dom.dSubmit.innerHTML = '<span class="spinner spinner-sm"></span> Discovering Features...';
    setDisabled(dom.dSubmit, true);
    setDisabled(dom.dName, true);
    setDisabled(dom.dUrl, true);
    setDisabled(dom.dEmail, true);
    show(dom.dHint);
  }

  function goReview() {
    state.phase = 'review';
    hideError();
    updateStepper(2, 1, 0);
    hide(dom.phaseDiscover);
    show(dom.phaseReview);
    hide(dom.phaseStatus);

    dom.rClient.textContent = state.clientName;
    dom.rUrl.textContent = state.homepageUrl;
    dom.rDesc.value = state.coreDesc;
    setDisabled(dom.rDesc, false);
    setDisabled(dom.rAdd, false);
    setDisabled(dom.rBack, false);
    dom.rSubmit.innerHTML = 'Start Analysis';
    renderFeatures();
  }

  function goSubmitting() {
    state.phase = 'submitting';
    hideError();
    dom.rSubmit.innerHTML = '<span class="spinner spinner-sm"></span> Starting Analysis...';
    setDisabled(dom.rSubmit, true);
    setDisabled(dom.rDesc, true);
    setDisabled(dom.rAdd, true);
    setDisabled(dom.rBack, true);
    disableAllFeatureInputs(true);
  }

  function goRunning() {
    state.phase = 'running';
    hideError();
    updateStepper(2, 2, 1);
    hide(dom.phaseDiscover);
    hide(dom.phaseReview);
    show(dom.phaseStatus);

    hide(dom.sComplete);
    show(dom.sProgress);
    show(dom.sPolling);
    hide(dom.sNewrun);

    dom.sSheetLink.href = state.sheetUrl;
    dom.sSheetUrl.textContent = state.sheetUrl;
    dom.sProgressCount = $('s-progress-count');
    dom.sProgressFill = $('s-progress-fill');

    updateProgress();
    renderEvents();

    // Update URL with run_id for bookmarking
    if (state.runId && window.history.replaceState) {
      var newUrl = window.location.pathname + '?run=' + state.runId;
      window.history.replaceState(null, '', newUrl);
    }
  }

  function goComplete() {
    state.phase = 'complete';
    updateStepper(2, 2, 2);

    show(dom.sComplete);
    hide(dom.sProgress);
    hide(dom.sPolling);
    show(dom.sNewrun);

    // Stop polling
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }

    // Complete message
    var compEvt = state.events.find(function (e) { return e.type === 'complete'; });
    var doneCount = state.events.filter(function (e) { return e.event === 'FEATURE_DONE'; }).length;
    dom.sCompleteMsg.textContent = (compEvt && compEvt.message)
      ? compEvt.message
      : doneCount + ' feature' + (doneCount !== 1 ? 's' : '') + ' analyzed';

    // Alert badges
    var warns = state.events.filter(function (e) { return e.type === 'alert_warning'; });
    var crits = state.events.filter(function (e) { return e.type === 'alert_critical'; });
    if (warns.length > 0 || crits.length > 0) {
      show(dom.sAlertBadges);
      var badgeHtml = '';
      if (warns.length > 0) {
        badgeHtml += '<span class="alert-badge alert-badge-warn">\u25B2 ' + warns.length + ' warning' + (warns.length !== 1 ? 's' : '') + '</span>';
      }
      if (crits.length > 0) {
        badgeHtml += '<span class="alert-badge alert-badge-crit">\u2715 ' + crits.length + ' critical</span>';
      }
      dom.sAlertBadges.innerHTML = badgeHtml;
    } else {
      hide(dom.sAlertBadges);
    }

    updateProgress();
    renderEvents();
  }


  // ─── Discover Form Validation ─────────────────────────────

  function validateDiscoverForm() {
    var nameOk = dom.dName.value.trim().length > 0;
    var urlOk = dom.dUrl.value.trim().length > 0;
    setDisabled(dom.dSubmit, !nameOk || !urlOk || state.phase === 'discovering');
  }


  // ─── Discovery Handler ────────────────────────────────────

  function handleDiscover(e) {
    e.preventDefault();

    // Honeypot check
    if (dom.dCompany.value.trim() !== '') {
      showError('Submission blocked.');
      return;
    }

    // Rate limit check
    var now = Date.now();
    if (now - state.lastSubmitTime < CONFIG.rateLimitMs) {
      var wait = Math.ceil((CONFIG.rateLimitMs - (now - state.lastSubmitTime)) / 1000);
      showError('Please wait ' + wait + ' seconds before submitting again.');
      return;
    }

    var name = dom.dName.value.trim();
    var url = dom.dUrl.value.trim();
    var email = dom.dEmail.value.trim() || CONFIG.defaultEmail;

    if (!name || !url) return;

    state.clientName = name;
    state.homepageUrl = url;
    state.userEmail = email;
    state.lastSubmitTime = now;

    goDiscovering();

    var payload = {
      client_name: name,
      homepage_url: url,
      user_email: email,
      cf_turnstile_token: getTurnstileToken()
    };

    fetch(CONFIG.discoveryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function (res) {
      if (!res.ok) throw new Error('Server error (' + res.status + ')');
      return res.json();
    })
    .then(function (data) {
      if (!data.success) throw new Error(data.message || 'Discovery failed');

      state.coreDesc = data.core_description || '';

      // Flatten features + expansions
      var flat = [];
      (data.features || []).forEach(function (f) {
        flat.push({
          id: uid(),
          name: f.name || '',
          url: f.url || '',
          short_description: f.short_description || '',
          type: f.type || 'Feature',
          selected: f.selected !== false,
          parent: '',
          custom: false
        });
        (f.expansions || []).forEach(function (ex) {
          flat.push({
            id: uid(),
            name: ex.name || '',
            url: ex.url || f.url || '',
            short_description: ex.short_description || '',
            type: 'Sub-feature',
            selected: ex.selected === true,
            parent: f.name || '',
            custom: false
          });
        });
      });
      state.features = flat;
      resetTurnstile();
      goReview();
    })
    .catch(function (err) {
      showError(err.message || 'Discovery failed. Please try again.');
      resetTurnstile();
      goDiscover();
    });
  }


  // ─── Feature List Rendering ───────────────────────────────

  function renderFeatures() {
    var list = dom.rList;
    list.innerHTML = '';

    state.features.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'feat-row' + (!f.selected ? ' dimmed' : '') + (f.parent ? ' indented' : '');
      row.dataset.id = f.id;

      var html = '';

      // Checkbox
      html += '<button type="button" class="feat-check' + (f.selected ? ' checked' : '') + '" data-action="toggle" data-id="' + f.id + '">';
      html += f.selected ? '\u2713' : '';
      html += '</button>';

      html += '<div class="feat-body">';
      html += '<div class="feat-header">';

      if (f.custom) {
        html += '<input class="input input-sm" style="font-weight:600;flex:1" placeholder="Feature name..." value="' + escHtml(f.name) + '" data-field="name" data-id="' + f.id + '">';
      } else {
        html += '<span class="feat-name">' + escHtml(f.name) + '</span>';
      }

      var badgeClass = f.type === 'Feature' ? 'feat-badge-feature'
        : f.type === 'Core' ? 'feat-badge-core' : 'feat-badge-sub';
      html += '<span class="feat-badge ' + badgeClass + '">' + escHtml(f.type) + '</span>';
      html += '</div>'; // feat-header

      if (f.custom) {
        html += '<input class="input input-sm" style="margin-bottom:4px" placeholder="Short description..." value="' + escHtml(f.short_description) + '" data-field="short_description" data-id="' + f.id + '">';
        html += '<input class="input input-sm" placeholder="https://..." value="' + escHtml(f.url) + '" data-field="url" data-id="' + f.id + '">';
      } else {
        if (f.short_description) {
          html += '<div class="feat-desc">' + escHtml(f.short_description) + '</div>';
        }
        if (f.url) {
          html += '<div class="feat-url">' + escHtml(f.url) + '</div>';
        }
      }

      html += '</div>'; // feat-body

      if (f.custom) {
        html += '<button type="button" class="feat-remove" data-action="remove" data-id="' + f.id + '">\u00D7</button>';
      }

      row.innerHTML = html;
      list.appendChild(row);
    });

    updateReviewCount();
  }

  function escHtml(str) {
    var div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function getSelectedCount() {
    return state.features.filter(function (f) { return f.selected && f.name.trim(); }).length;
  }

  function updateReviewCount() {
    var sel = getSelectedCount();
    dom.rCount.textContent = sel + ' of ' + state.features.length + ' selected';
    dom.rSubmit.textContent = 'Start Analysis \u2014 ' + sel + ' feature' + (sel !== 1 ? 's' : '');
    setDisabled(dom.rSubmit, sel === 0 || state.phase === 'submitting');
  }

  function disableAllFeatureInputs(val) {
    var inputs = dom.rList.querySelectorAll('input, button');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].disabled = val;
    }
  }


  // ─── Feature List Event Delegation ────────────────────────

  function handleFeatureClick(e) {
    var target = e.target;
    var action = target.dataset.action;
    var id = target.dataset.id;

    if (state.phase === 'submitting') return;

    if (action === 'toggle') {
      var feat = state.features.find(function (f) { return f.id === id; });
      if (feat) { feat.selected = !feat.selected; renderFeatures(); }
    }
    else if (action === 'remove') {
      state.features = state.features.filter(function (f) { return f.id !== id; });
      renderFeatures();
    }
  }

  function handleFeatureInput(e) {
    var target = e.target;
    var field = target.dataset.field;
    var id = target.dataset.id;
    if (!field || !id) return;

    var feat = state.features.find(function (f) { return f.id === id; });
    if (feat) {
      feat[field] = target.value;
      if (field === 'name') updateReviewCount();
    }
  }

  function addCustomFeature() {
    if (state.phase === 'submitting') return;
    state.features.push({
      id: uid(),
      name: '',
      url: '',
      short_description: '',
      type: 'Feature',
      selected: true,
      parent: '',
      custom: true
    });
    renderFeatures();
    // Focus the new name input
    var lastRow = dom.rList.lastElementChild;
    if (lastRow) {
      var nameInput = lastRow.querySelector('[data-field="name"]');
      if (nameInput) nameInput.focus();
    }
  }


  // ─── Analysis Handler ─────────────────────────────────────

  function handleAnalyze() {
    var selected = state.features.filter(function (f) { return f.selected && f.name.trim(); });
    if (selected.length === 0) return;

    // Rate limit
    var now = Date.now();
    if (now - state.lastSubmitTime < CONFIG.rateLimitMs) {
      var wait = Math.ceil((CONFIG.rateLimitMs - (now - state.lastSubmitTime)) / 1000);
      showError('Please wait ' + wait + ' seconds before submitting again.');
      return;
    }
    state.lastSubmitTime = now;

    state.coreDesc = dom.rDesc.value.trim();
    state.totalFeatures = selected.length;

    goSubmitting();

    var payload = {
      client_name: state.clientName,
      core_description: state.coreDesc,
      user_email: state.userEmail || CONFIG.defaultEmail,
      features: selected.map(function (f) {
        return {
          name: f.name.trim(),
          url: (f.url || '').trim(),
          short_description: (f.short_description || '').trim(),
          type: f.type,
          parent_feature: f.parent || ''
        };
      })
    };

    fetch(CONFIG.analysisUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    .then(function (res) {
      if (!res.ok) throw new Error('Server error (' + res.status + ')');
      return res.json();
    })
    .then(function (data) {
      if (!data.success) throw new Error(data.message || 'Analysis failed to start');
      state.runId = data.run_id;
      state.sheetUrl = data.sheet_url;
      state.events = [];
      goRunning();
      startPolling();
    })
    .catch(function (err) {
      showError(err.message || 'Failed to start analysis.');
      goReview();
    });
  }


  // ─── Polling ──────────────────────────────────────────────

  function startPolling() {
    fetchEvents(); // immediate first fetch
    state.pollTimer = setInterval(fetchEvents, CONFIG.pollInterval);
  }

  function stopPolling() {
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function fetchEvents() {
    var rid = state.runId;
    if (!rid) return;

    var tq = encodeURIComponent("SELECT * WHERE A = '" + rid + "'");
    var url = 'https://docs.google.com/spreadsheets/d/' + CONFIG.masterLogId
      + '/gviz/tq?tqx=out:json&sheet=Events&tq=' + tq + '&headers=1&_t=' + Date.now();

    fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error('Poll error');
        return res.text();
      })
      .then(function (text) {
        state.pollError = false;
        updatePollIndicator();

        var rows = parseGviz(text);
        if (rows.length > 0) {
          state.events = rows;
          renderEvents();
          updateProgress();

          // Check for completion
          var hasComplete = rows.some(function (r) { return r.type === 'complete'; });
          if (hasComplete) {
            goComplete();
          }
        }
      })
      .catch(function () {
        state.pollError = true;
        updatePollIndicator();
      });
  }

  function updatePollIndicator() {
    if (state.phase === 'complete') return;
    dom.sPollDot.className = 'poll-dot' + (state.pollError ? ' warn' : '');
    dom.sPollText.textContent = state.pollError ? 'Connection issue, retrying...' : 'Polling every ' + (CONFIG.pollInterval / 1000) + 's';
  }


  // ─── Progress Bar ─────────────────────────────────────────

  function updateProgress() {
    var done = state.events.filter(function (e) { return e.event === 'FEATURE_DONE'; }).length;
    var total = state.totalFeatures;
    var isComp = state.phase === 'complete';

    // If we don't know total yet (resume scenario), estimate from events
    if (total === 0 && done > 0) {
      total = done + (isComp ? 0 : 1); // assume at least 1 more unless complete
    }
    if (total === 0) total = 1; // prevent division by zero

    var pct = isComp ? 100 : Math.min(95, Math.round((done / total) * 90) + 5);

    $('s-progress-count').textContent = done + '/' + (state.totalFeatures || '?');
    $('s-progress-fill').style.width = pct + '%';
  }


  // ─── Event Rendering ──────────────────────────────────────

  function renderEvents() {
    var container = dom.eventsList;

    // Clear
    container.innerHTML = '';

    if (state.events.length === 0 && state.phase !== 'complete') {
      container.innerHTML = '<div class="evt-empty"><span class="spinner spinner-md" style="display:block;margin:0 auto 8px"></span><div>Waiting for events...</div></div>';
      return;
    }

    state.events.forEach(function (evt) {
      var s = EVT_STYLES[evt.type] || EVT_STYLES.system;
      var isAlert = evt.type === 'alert_warning' || evt.type === 'alert_critical';

      var row = document.createElement('div');
      row.className = 'evt-row' + (isAlert ? ' alert' : '');
      row.style.background = s.bg;
      if (isAlert) {
        row.style.borderLeftColor = s.color;
      }

      var html = '';

      // Icon
      html += '<div class="evt-icon" style="color:' + s.color + ';background:' + s.color + '18">' + s.icon + '</div>';

      // Time
      html += '<div class="evt-time">' + fmtTime(evt.timestamp) + '</div>';

      // Body
      html += '<div class="evt-body">';
      if (evt.feature) {
        html += '<div class="evt-feature" style="color:' + s.color + '">' + escHtml(evt.feature) + '</div>';
      }
      html += '<div class="evt-message">' + escHtml(evt.message) + '</div>';
      html += '</div>';

      row.innerHTML = html;
      container.appendChild(row);
    });

    // Auto-scroll to bottom during running phase
    if (state.phase === 'running') {
      container.scrollTop = container.scrollHeight;
    }
  }


  // ─── Reset ────────────────────────────────────────────────

  function handleReset() {
    stopPolling();
    state.phase = 'discover';
    state.clientName = '';
    state.homepageUrl = '';
    state.userEmail = '';
    state.coreDesc = '';
    state.features = [];
    state.runId = '';
    state.sheetUrl = '';
    state.events = [];
    state.totalFeatures = 0;
    state.pollError = false;

    dom.dName.value = '';
    dom.dUrl.value = '';
    dom.dEmail.value = '';
    dom.dCompany.value = '';

    // Clear URL parameter
    if (window.history.replaceState) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    resetTurnstile();
    goDiscover();
  }


  // ─── URL Parameter: Resume Status ─────────────────────────

  function checkUrlParams() {
    var params = new URLSearchParams(window.location.search);
    var runId = params.get('run');
    if (!runId || !runId.trim()) return;

    state.runId = runId.trim();
    state.phase = 'running';

    hide(dom.phaseDiscover);
    hide(dom.phaseReview);
    show(dom.phaseStatus);
    updateStepper(2, 2, 1);

    hide(dom.sComplete);
    show(dom.sProgress);
    show(dom.sPolling);
    hide(dom.sNewrun);

    // Hide sheet link until we find it
    dom.sSheetLink.style.display = 'none';

    // Try to load sheet URL from Runs tab
    tryLoadRunInfo(state.runId);

    startPolling();
  }

  // Attempt to load sheet_url from Master Log Runs tab
  function tryLoadRunInfo(rid) {
    var tq = encodeURIComponent("SELECT * WHERE A = '" + rid + "' LIMIT 1");
    var url = 'https://docs.google.com/spreadsheets/d/' + CONFIG.masterLogId
      + '/gviz/tq?tqx=out:json&sheet=Runs&tq=' + tq + '&headers=1&_t=' + Date.now();

    fetch(url)
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (text) {
        if (!text) return;
        try {
          var match = text.match(/setResponse\(([\s\S]+)\)\s*;?\s*$/);
          var json = match ? JSON.parse(match[1]) : null;
          if (json && json.table && json.table.rows && json.table.rows.length > 0) {
            var row = json.table.rows[0].c || [];
            // Runs columns: A(0)=Run ID, B(1)=Client, C(2)=Started, D(3)=Finished,
            //   E(4)=Duration, F(5)=Features, G(6)=Status, H(7)=Alerts, I(8)=Sheet URL, J(9)=Email
            var sheetUrlVal = row[8] && row[8].v ? row[8].v : '';
            var featCountVal = row[5] && row[5].v ? parseInt(row[5].v, 10) : 0;
            var clientVal = row[1] && row[1].v ? row[1].v : '';

            if (sheetUrlVal) {
              state.sheetUrl = sheetUrlVal;
              dom.sSheetLink.href = sheetUrlVal;
              dom.sSheetUrl.textContent = sheetUrlVal;
              dom.sSheetLink.style.display = '';
            }
            if (featCountVal > 0) {
              state.totalFeatures = featCountVal;
            }
            if (clientVal) {
              state.clientName = clientVal;
            }
          }
        } catch (e) { /* silent */ }
      })
      .catch(function () { /* silent */ });
  }


  // ─── Init ─────────────────────────────────────────────────

  function init() {
    cacheDom();

    // Always attach event listeners (needed even after URL resume → New Analysis)
    dom.dForm.addEventListener('submit', handleDiscover);
    dom.dName.addEventListener('input', validateDiscoverForm);
    dom.dUrl.addEventListener('input', validateDiscoverForm);

    dom.rList.addEventListener('click', handleFeatureClick);
    dom.rList.addEventListener('input', handleFeatureInput);
    dom.rAdd.addEventListener('click', addCustomFeature);
    dom.rBack.addEventListener('click', function () { goDiscover(); });
    dom.rSubmit.addEventListener('click', handleAnalyze);

    dom.sReset.addEventListener('click', handleReset);

    // Check if resuming from URL param
    checkUrlParams();
  }

  // Boot
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
