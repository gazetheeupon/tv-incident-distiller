(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var SAMPLE_LOG = [
    '2026-09-23T14:02:10.031Z INFO [shell] app=edge-player build=4.18.0 device_family=samsung-2025',
    '2026-09-23T14:02:11.442Z INFO [manifest] GET /v2/live/stream.m3u8 status=200 cache=hit',
    '2026-09-23T14:02:13.008Z WARN [playback] startup_ms=2480 device_ram_mb=1536',
    '2026-09-23T14:02:14.226Z INFO [drm] key_system=widevine security_level=L1 license=ready',
    '2026-09-23T14:02:15.901Z ERROR [playback] first_frame_timeout device_family=samsung-2025',
    '2026-09-23T14:02:16.220Z ERROR [network] manifest_retry url=/v2/live/stream.m3u8 status=503 attempt=1',
    '2026-09-23T14:02:18.641Z ERROR [network] manifest_retry url=/v2/live/stream.m3u8 status=503 attempt=2',
    '2026-09-23T14:02:20.998Z WARN [playback] buffer_underrun_ms=740',
    '2026-09-23T14:02:22.120Z INFO [shell] user_abort action=back',
    '2026-09-23T14:02:22.441Z ERROR [network] segment_fetch status=404 path=/v2/live/segment-00891.ts'
  ].join('\n');
  var FAMILY_RULES = [
    {
      key: 'delivery',
      label: 'Delivery / manifest path',
      pattern: /\b(manifest|m3u8|mpd|segment|cdn|origin|edge|fetch|retry|signed|cache|status\s*[=:]\s*[45]\d\d|http)\b/i,
      summary: 'The strongest repeated signal is in the delivery chain: manifests, segments, CDN responses, or fetch retries.',
      checks: [
        'Fetch the exact manifest or segment URL from one failing TV and record status, content type, and response bytes.',
        'Compare CDN edge and origin behavior, including cache headers, signed URL expiry, and retry policy.',
        'Play the same content on one known-good device and one failing device to separate delivery from decoder behavior.'
      ]
    },
    {
      key: 'drm',
      label: 'DRM / license path',
      pattern: /\b(drm|eme|license|licen[cs]e|widevine|fairplay|playready|key_system|security_level|ke)\b/i,
      summary: 'The log is leaning toward license acquisition, key-system negotiation, or playback entitlement.',
      checks: [
        'Capture the license endpoint response and key-system negotiation from the failing device family.',
        'Compare token expiry, entitlement, and renewal behavior against a successful playback session.',
        'Test a short session and a sustained session to separate initial license failure from renewal failure.'
      ]
    },
    {
      key: 'playback',
      label: 'Playback / decode path',
      pattern: /\b(playback|first_frame|startup|buffer|stall|freeze|video|audio|codec|decode|renderer|frame|black.screen|a.v.sync|dropped)\b/i,
      summary: 'The signal points toward the player path: startup, buffering, decode, frame delivery, or audio/video synchronization.',
      checks: [
        'Measure startup-to-first-byte and startup-to-first-frame separately on the failing model.',
        'Record a short known-good clip and the failing clip on the same TV, network, and audio route.',
        'Check sustained playback and memory pressure on the lowest-memory supported device.'
      ]
    },
    {
      key: 'focus',
      label: 'Remote / focus path',
      pattern: /\b(focus|dpad|d-pad|remote|key|back.button|navigation|navigate|keyevent|input|traversal|select)\b/i,
      summary: 'The evidence is concentrated around remote input, focus traversal, or exit behavior.',
      checks: [
        'Record the D-pad path through every screen involved, including the exact point focus disappears.',
        'Verify Back behavior from the player, browser shell, and OS home handoff on the target platform.',
        'Test the release on a real remote model, not only with a desktop keyboard or emulator.'
      ]
    },
    {
      key: 'identity',
      label: 'Identity / entitlement path',
      pattern: /\b(auth|login|logout|token|session|entitlement|purchase|account|cookie|jwt|credential|unauthori[sz]ed|forbidden)\b/i,
      summary: 'The strongest clue is around identity, session state, or entitlement rather than the media bytes themselves.',
      checks: [
        'Compare the failing session token and entitlement response with a known-good session without logging secrets.',
        'Check token refresh, expiry, and account switching around the exact failure timestamp.',
        'Reproduce once with a fresh session and once with the original session to isolate session state.'
      ]
    }
  ];
  var GENERAL_CHECKS = [
    'Capture one known-good and one failing session with the same content, device family, and network route.',
    'Add a user-visible symptom to the log: black screen, endless spinner, audio without video, exit, or wrong content.',
    'Keep the next test small enough to run before the next release window.'
  ];
  var state = { result: null, filter: 'all' };

  function parseTimestamp(line) {
    var iso = line.match(/^\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\s+/);
    if (iso) {
      var isoValue = Date.parse(iso[1]);
      return { value: isNaN(isoValue) ? null : isoValue, label: iso[1].replace('T', ' ').replace('Z', '').replace('+00:00', '') };
    }
    var syslog = line.match(/^\s*([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+/);
    if (syslog) {
      var sysValue = Date.parse(new Date().getFullYear() + ' ' + syslog[1] + ' UTC');
      return { value: isNaN(sysValue) ? null : sysValue, label: syslog[1] };
    }
    var time = line.match(/^\s*\[?(\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s+/);
    if (time) {
      var clock = time[1].replace(',', '.').replace(/(Z|[+-]\d{2}:?\d{2})$/i, '');
      var parts = clock.split(':');
      return { value: Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]), label: time[1] };
    }
    return { value: null, label: '—' };
  }

  function severityFor(line) {
    var match = line.match(/\b(EMERGENCY|FATAL|CRITICAL|ALERT|ERROR|ERR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/i);
    if (match) {
      var word = match[1].toUpperCase();
      if (word === 'EMERGENCY' || word === 'FATAL' || word === 'CRITICAL' || word === 'ALERT' || word === 'ERROR' || word === 'ERR') return 'error';
      if (word === 'WARN' || word === 'WARNING') return 'warn';
      if (word === 'INFO') return 'info';
      return 'debug';
    }
    if (/\b(status\s*[=:]\s*[45]\d\d|exception|panic|failed|failure|timeout|unavailable|abort)\b/i.test(line)) return 'error';
    if (/\b(deprecated|slow|retry|warn|fallback|underrun)\b/i.test(line)) return 'warn';
    return 'info';
  }

  function sourceFor(line) {
    var bracket = line.match(/\[([A-Za-z][A-Za-z0-9_.-]{1,32})\]/);
    if (bracket) return bracket[1];
    var prefix = line.replace(/^\s*(?:\[[^\]]+\]|\d{4}-\d{2}-\d{2}T[^\s]+\s+)/, '').match(/^([A-Za-z][A-Za-z0-9_.-]{1,32}):/);
    return prefix ? prefix[1] : 'log';
  }

  function cleanMessage(line) {
    return line.replace(/\s+/g, ' ').trim();
  }

  function signatureFor(message) {
    return message
      .toLowerCase()
      .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:z|[+-]\d{2}:?\d{2})?/g, '<ts>')
      .replace(/\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:z|[+-]\d{2}:?\d{2})?\b/g, '<ts>')
      .replace(/https?:\/\/[^\s]+/g, '<url>')
      .replace(/\b(session|request|request_id|trace|trace_id|device_id|user_id|id)=[^\s]+/g, '$1=<id>')
      .replace(/\b[0-9a-f]{8,}\b/gi, '<id>')
      .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function statusCodesFor(message) {
    var codes = [];
    var pattern = /\b(?:status|http(?:status)?|response)\s*[=:]\s*([45]\d\d)\b/gi;
    var match;
    while ((match = pattern.exec(message)) !== null) codes.push(match[1]);
    if (!codes.length) {
      var loose = /\b([45]\d\d)\b/g;
      while ((match = loose.exec(message)) !== null) codes.push(match[1]);
    }
    return codes;
  }

  function parseEvents(text) {
    return String(text || '').split(/\r?\n/).map(function (line, index) {
      var raw = cleanMessage(line);
      if (!raw) return null;
      var timestamp = parseTimestamp(raw);
      return {
        index: index,
        raw: raw,
        message: raw,
        time: timestamp.label,
        timestamp: timestamp.value,
        severity: severityFor(raw),
        source: sourceFor(raw),
        signature: signatureFor(raw),
        statusCodes: statusCodesFor(raw)
      };
    }).filter(Boolean);
  }

  function formatDuration(milliseconds) {
    if (milliseconds === null || milliseconds === undefined || isNaN(milliseconds)) return '—';
    if (milliseconds < 1000) return Math.max(0, Math.round(milliseconds)) + 'ms';
    var seconds = Math.round(milliseconds / 1000);
    if (seconds < 60) return seconds + 's';
    var minutes = Math.floor(seconds / 60);
    var remainder = seconds % 60;
    if (minutes < 60) return minutes + 'm ' + remainder + 's';
    return Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm';
  }

  function countBy(items, key) {
    var counts = {};
    items.forEach(function (item) {
      var value = typeof key === 'function' ? key(item) : item[key];
      if (value === undefined || value === null || value === '') return;
      counts[value] = (counts[value] || 0) + 1;
    });
    return counts;
  }

  function topEntries(counts, limit) {
    return Object.keys(counts).map(function (key) {
      return { value: key, count: counts[key] };
    }).sort(function (a, b) { return b.count - a.count || a.value.localeCompare(b.value); }).slice(0, limit || 5);
  }

  function familyFor(events) {
    var scores = FAMILY_RULES.map(function (rule) {
      var matches = 0;
      var errors = 0;
      events.forEach(function (event) {
        if (rule.pattern.test(event.raw)) {
          matches += 1;
          if (event.severity === 'error') errors += 1;
        }
      });
      return { rule: rule, matches: matches, errors: errors, score: matches + (errors * 2) };
    }).filter(function (entry) { return entry.matches > 0; }).sort(function (a, b) { return b.score - a.score || a.rule.label.localeCompare(b.rule.label); });
    return scores[0] || { rule: null, matches: 0, errors: 0, score: 0 };
  }

  function uniqueChecks(values) {
    var result = [];
    values.forEach(function (value) {
      if (value && result.indexOf(value) === -1) result.push(value);
    });
    return result.slice(0, 3);
  }

  function checksFor(result) {
    var values = result.focus.rule ? result.focus.rule.checks.slice() : GENERAL_CHECKS.slice();
    if (result.statusCounts['5xx']) values.unshift('Treat any 5xx response as a delivery-path lead until the edge and origin disagree for a reason.');
    if (result.repeated.length) values.push('Replay one repeated signature against a known-good session before widening the investigation.');
    if (!values.length) values = GENERAL_CHECKS;
    while (values.length < 3) values.push(GENERAL_CHECKS[values.length % GENERAL_CHECKS.length]);
    return uniqueChecks(values);
  }

  function evidenceGaps(result) {
    var gaps = [];
    if (!result.events.some(function (event) { return event.timestamp !== null; })) gaps.push('Add timestamps so the event span can be measured.');
    if (!/device|model|family|platform|os\b/i.test(result.rawText)) gaps.push('Capture the failing device model, platform, and OS build.');
    if (!result.statusCounts['4xx'] && !result.statusCounts['5xx']) gaps.push('Record exact HTTP status and response body for failed requests.');
    if (!result.events.some(function (event) { return event.severity === 'info'; })) gaps.push('Add one known-good event so the failure boundary is visible.');
    if (!gaps.length) gaps.push('Keep a clean session from the same content and network route for comparison.');
    return gaps.slice(0, 4);
  }

  function markdownEscape(value) {
    return String(value).replace(/`/g, '\\`').replace(/\r?\n/g, ' ');
  }

  function buildMarkdown(result) {
    var lines = [
      '# TV Incident Distiller',
      '',
      '## Incident',
      '- Name: ' + markdownEscape(result.name || 'Untitled incident'),
      '- Lane / service: ' + markdownEscape(result.lane || 'unspecified'),
      '- Lines read: ' + result.events.length,
      '- Time span: ' + result.duration,
      '',
      '## Triage focus',
      result.focus.rule ? result.focus.rule.label : 'Playback incident triage',
      '',
      result.summary,
      '',
      '## Signal counts',
      '- Errors: ' + result.errors,
      '- Warnings: ' + result.warnings,
      '- HTTP 4xx: ' + (result.statusCounts['4xx'] || 0),
      '- HTTP 5xx: ' + (result.statusCounts['5xx'] || 0),
      '',
      '## Repeated signatures',
      result.repeated.length ? result.repeated.map(function (item) { return '- ' + item.count + '× ' + markdownEscape(item.value); }).join('\n') : '- No repeated signatures found.',
      '',
      '## Next three checks',
      result.checks.map(function (check, index) { return (index + 1) + '. ' + check; }).join('\n'),
      '',
      '## Evidence still missing',
      result.gaps.map(function (gap) { return '- ' + gap; }).join('\n'),
      '',
      '## Signal timeline',
      result.events.slice(0, 200).map(function (event) { return '- ' + event.time + ' **' + event.severity.toUpperCase() + '** [' + event.source + '] ' + markdownEscape(event.message); }).join('\n')
    ];
    return lines.join('\n') + '\n';
  }

  function buildJson(result) {
    return JSON.stringify({
      name: result.name,
      lane: result.lane,
      focus: result.focus.rule ? result.focus.rule.key : 'general',
      summary: result.summary,
      durationMs: result.durationMs,
      events: result.events,
      repeated: result.repeated,
      checks: result.checks,
      evidenceGaps: result.gaps
    }, null, 2);
  }

  function analyze(text, name, lane) {
    var events = parseEvents(text);
    var errors = events.filter(function (event) { return event.severity === 'error'; }).length;
    var warnings = events.filter(function (event) { return event.severity === 'warn'; }).length;
    var timestamps = events.map(function (event) { return event.timestamp; }).filter(function (value) { return value !== null; });
    var durationMs = timestamps.length > 1 ? Math.max.apply(null, timestamps) - Math.min.apply(null, timestamps) : null;
    var statusCounts = { '4xx': 0, '5xx': 0 };
    events.forEach(function (event) {
      event.statusCodes.forEach(function (code) {
        statusCounts[code] = (statusCounts[code] || 0) + 1;
        if (code.charAt(0) === '4') statusCounts['4xx'] += 1;
        if (code.charAt(0) === '5') statusCounts['5xx'] += 1;
      });
    });
    var signatureCounts = countBy(events.filter(function (event) { return event.severity === 'error' || event.severity === 'warn'; }), 'signature');
    var repeated = topEntries(signatureCounts, 4).filter(function (item) { return item.count > 1; });
    var focus = familyFor(events);
    var result = { rawText: String(text || ''), name: name || 'Untitled incident', lane: lane || 'unspecified', events: events, errors: errors, warnings: warnings, durationMs: durationMs, duration: formatDuration(durationMs), statusCounts: statusCounts, repeated: repeated, focus: focus };
    result.summary = focus.rule
      ? focus.rule.summary + ' ' + focus.matches + ' matching line' + (focus.matches === 1 ? '' : 's') + ', including ' + focus.errors + ' error' + (focus.errors === 1 ? '' : 's') + ', drove this focus.'
      : events.length
        ? 'No domain-specific family dominated the log. Start by separating the user-visible failure from the surrounding noise.'
        : 'There are no non-empty log lines to interpret yet.';
    result.checks = checksFor(result);
    result.gaps = evidenceGaps(result);
    return result;
  }

  function renderTimeline(result) {
    var timeline = $('timeline');
    var visible = result.events.filter(function (event) {
      if (state.filter === 'all') return true;
      if (state.filter === 'error') return event.severity === 'error';
      if (state.filter === 'warn') return event.severity === 'warn';
      return event.severity === 'info';
    });
    timeline.textContent = '';
    if (!visible.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = result.events.length ? 'No events match this filter.' : 'No events distilled yet.';
      timeline.appendChild(empty);
      return;
    }
    visible.slice(0, 120).forEach(function (event) {
      var row = document.createElement('div');
      row.className = 'event';
      var time = document.createElement('span');
      time.className = 'event-time';
      time.title = event.time;
      time.textContent = event.time;
      var severity = document.createElement('span');
      severity.className = 'severity ' + event.severity;
      severity.textContent = event.severity.toUpperCase();
      var message = document.createElement('span');
      message.className = 'event-message';
      message.textContent = '[' + event.source + '] ' + event.message;
      row.appendChild(time);
      row.appendChild(severity);
      row.appendChild(message);
      timeline.appendChild(row);
    });
  }

  function render(result) {
    state.result = result;
    $('focusTitle').textContent = result.focus.rule ? 'Start with the ' + result.focus.rule.label.toLowerCase() : 'Start with a general playback triage';
    $('focusCopy').textContent = result.summary;
    $('eventCount').textContent = result.events.length;
    $('errorCount').textContent = result.errors;
    $('warningCount').textContent = result.warnings;
    $('duration').textContent = result.duration;
    $('signatureText').textContent = result.repeated.length ? result.repeated.map(function (item) { return item.count + '× ' + item.value; }).join(' · ') : 'No repeated error or warning signatures found.';
    $('checksList').textContent = '';
    result.checks.forEach(function (check) {
      var item = document.createElement('li');
      item.textContent = check;
      $('checksList').appendChild(item);
    });
    $('reportPreview').textContent = buildMarkdown(result);
    $('reportStatus').textContent = result.events.length ? 'distilled' : 'empty';
    renderTimeline(result);
  }

  function updateLineCount() {
    var count = $('logText').value.split(/\r?\n/).filter(function (line) { return line.trim(); }).length;
    $('logCounter').textContent = count + (count === 1 ? ' line' : ' lines');
  }

  function distill(message) {
    var result = analyze($('logText').value, $('incidentName').value, $('serviceLane').value);
    render(result);
    $('analysisStatus').textContent = message || (result.events.length ? 'Distilled ' + result.events.length + ' event lines locally.' : 'The intake is empty. Add a log or load the sample.');
  }

  function fallbackCopy(text) {
    var field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(field);
    field.select();
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
    field.remove();
    if (!copied) throw new Error('Clipboard access was not available');
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () {
        try { fallbackCopy(text); return Promise.resolve(); } catch (error) { return Promise.reject(error); }
      });
    }
    return new Promise(function (resolve, reject) {
      try { fallbackCopy(text); resolve(); } catch (error) { reject(error); }
    });
  }

  function download(filename, content, mime) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  function filenameBase() {
    var value = ($('incidentName').value || 'tv-incident').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return value || 'tv-incident';
  }

  function bindEvents() {
    $('logText').addEventListener('input', updateLineCount);
    $('analyzeBtn').addEventListener('click', function () { distill(); });
    $('sampleBtn').addEventListener('click', function () {
      $('logText').value = SAMPLE_LOG;
      updateLineCount();
      distill('Sample evidence loaded and distilled locally.');
    });
    $('clearBtn').addEventListener('click', function () {
      $('logText').value = '';
      $('incidentName').value = '';
      $('serviceLane').value = '';
      updateLineCount();
      distill('Intake cleared. The next incident can be messy too.');
    });
    document.querySelectorAll('.filter').forEach(function (button) {
      button.addEventListener('click', function () {
        state.filter = button.getAttribute('data-filter');
        document.querySelectorAll('.filter').forEach(function (item) { item.classList.toggle('active', item === button); });
        if (state.result) renderTimeline(state.result);
      });
    });
    $('copyBtn').addEventListener('click', function () {
      if (!state.result || !state.result.events.length) {
        $('copyStatus').textContent = 'There is no incident card to copy yet.';
        return;
      }
      copyText(buildMarkdown(state.result)).then(function () {
        $('copyStatus').textContent = 'Incident card copied. The log never left this tab.';
      }).catch(function () {
        $('copyStatus').textContent = 'Clipboard access was unavailable. Download the Markdown instead.';
      });
    });
    $('markdownBtn').addEventListener('click', function () {
      if (!state.result || !state.result.events.length) {
        $('copyStatus').textContent = 'There is no Markdown export yet.';
        return;
      }
      download(filenameBase() + '-incident-card.md', buildMarkdown(state.result), 'text/markdown;charset=utf-8');
      $('copyStatus').textContent = 'Markdown incident card downloaded.';
    });
    $('jsonBtn').addEventListener('click', function () {
      if (!state.result || !state.result.events.length) {
        $('copyStatus').textContent = 'There is no JSON export yet.';
        return;
      }
      download(filenameBase() + '-incident-card.json', buildJson(state.result), 'application/json;charset=utf-8');
      $('copyStatus').textContent = 'JSON evidence bundle downloaded.';
    });
  }

  window.TVIncidentDistiller = {
    parse: parseEvents,
    analyze: analyze,
    markdown: buildMarkdown
  };

  bindEvents();
  updateLineCount();
  distill('Sample evidence loaded. Distill it whenever you are ready.');
})();
