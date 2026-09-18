(function(){
  "use strict";

  /* ---------------- state & storage ---------------- */
  var DEFAULT_SETTINGS = {
    boost: 2, captionSize: 2, theme: "auto", advanced: false,
    emergencyName: "", emergencyPhone: "", showEmergency: true,
    freq: 2500, boostDb: 9
  };
  var settings = loadJSON("ha_settings", DEFAULT_SETTINGS);
  var sessions = loadJSON("ha_sessions", []);
  var onboarded = localStorage.getItem("ha_onboarded") === "1";

  function loadJSON(key, fallback){
    try{
      var raw = localStorage.getItem(key);
      if(!raw) return JSON.parse(JSON.stringify(fallback));
      return Object.assign(JSON.parse(JSON.stringify(fallback)), JSON.parse(raw));
    }catch(e){ return JSON.parse(JSON.stringify(fallback)); }
  }
  function saveSettings(){ try{ localStorage.setItem("ha_settings", JSON.stringify(settings)); }catch(e){} }
  function saveSessions(){ try{ localStorage.setItem("ha_sessions", JSON.stringify(sessions.slice(0,30))); }catch(e){} }

  function applyTheme(){
    var root = document.documentElement;
    if(settings.theme === "light") root.setAttribute("data-theme","light");
    else if(settings.theme === "dark") root.setAttribute("data-theme","dark");
    else root.removeAttribute("data-theme");
  }
  applyTheme();

  /* ---------------- view switching ---------------- */
  var views = {};
  ["onboard","home","transcripts","transcript-detail","setup"].forEach(function(id){
    views[id] = document.getElementById("view-"+id);
  });
  function showView(id){
    Object.keys(views).forEach(function(k){ views[k].classList.toggle("active", k===id); });
  }
  if(onboarded){ showView("home"); } else { showView("onboard"); }

  document.getElementById("btn-onboard-continue").addEventListener("click", function(){
    localStorage.setItem("ha_onboarded","1");
    showView("home");
  });

  /* ---------------- audio engine ---------------- */
  var audioCtx = null, micStream = null, sourceNode = null, gainNode = null, filterNode = null, analyserNode = null;
  var isListening = false;
  var noiseRAF = null;

  function currentSettingsIntoUI(){
    document.getElementById("boost-slider").value = settings.boost;
    document.getElementById("boost-value").textContent = Number(settings.boost).toFixed(1) + "×";
    document.getElementById("freq-slider").value = settings.freq;
    document.getElementById("freq-value").textContent = settings.freq + " Hz";
    document.getElementById("db-slider").value = settings.boostDb;
    document.getElementById("db-value").textContent = settings.boostDb + " dB";
    document.getElementById("advanced-controls").style.display = settings.advanced ? "flex" : "none";
    document.getElementById("simple-controls").style.display = "flex";
    applyCaptionSizeToDOM();
    updateEmergencyLabel();
    applyEmergencyVisibility();
  }
  currentSettingsIntoUI();

  async function startListening(){
    try{
      micStream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true}});
    }catch(err){
      alert("This app needs microphone access to work. Please allow microphone access and try again.");
      return;
    }
    micStream = await preferBuiltInMic(micStream);
    var AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    if(audioCtx.state === "suspended"){ try{ await audioCtx.resume(); }catch(e){} }

    sourceNode = audioCtx.createMediaStreamSource(micStream);
    gainNode = audioCtx.createGain();
    gainNode.gain.value = Number(settings.boost);

    filterNode = audioCtx.createBiquadFilter();
    filterNode.type = "peaking";
    filterNode.frequency.value = Number(settings.freq);
    filterNode.Q.value = 1.0;
    filterNode.gain.value = Number(settings.boostDb);

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 512;

    sourceNode.connect(gainNode);
    gainNode.connect(filterNode);
    filterNode.connect(analyserNode);
    filterNode.connect(audioCtx.destination);

    isListening = true;
    document.getElementById("stage").classList.add("listening");
    document.getElementById("listen-icon").textContent = "⏸️";
    document.getElementById("listen-label").textContent = "Stop";
    document.getElementById("status-dot").classList.add("on");
    document.getElementById("status-text").textContent = "Listening";
    checkHeadphoneHint();
    startNoiseMeter();
    startCaptions();
    requestWakeLock();
    beginSession();
    document.getElementById("btn-lock").style.display = "flex";
  }

  function stopListening(){
    isListening = false;
    document.getElementById("stage").classList.remove("listening");
    document.getElementById("listen-icon").textContent = "🎙️";
    document.getElementById("listen-label").textContent = "Start";
    document.getElementById("status-dot").classList.remove("on");
    document.getElementById("status-text").textContent = "Not listening";
    stopNoiseMeter();
    stopCaptions();
    releaseWakeLock();
    hideMicWarning();
    document.getElementById("btn-lock").style.display = "none";
    unlockScreen(); // never leave the lock up when listening has ended
    if(micStream){ micStream.getTracks().forEach(function(t){ t.stop(); }); micStream = null; }
    if(audioCtx){ audioCtx.close().catch(function(){}); audioCtx = null; }
    document.getElementById("noise-fill").style.width = "0%";
  }

  document.getElementById("btn-listen").addEventListener("click", function(){
    if(isListening) stopListening(); else startListening();
  });

  function startNoiseMeter(){
    var data = new Uint8Array(analyserNode.frequencyBinCount);
    var fill = document.getElementById("noise-fill");
    function tick(){
      if(!isListening || !analyserNode) return;
      analyserNode.getByteFrequencyData(data);
      var sum = 0;
      for(var i=0;i<data.length;i++) sum += data[i];
      var avg = sum / data.length;
      var pct = Math.min(100, Math.round((avg/140)*100));
      fill.style.width = pct + "%";
      noiseRAF = requestAnimationFrame(tick);
    }
    tick();
  }
  function stopNoiseMeter(){ if(noiseRAF) cancelAnimationFrame(noiseRAF); noiseRAF = null; }

  async function checkHeadphoneHint(){
    var note = document.getElementById("headphone-note");
    try{
      var devices = await navigator.mediaDevices.enumerateDevices();
      var found = devices.some(function(d){
        return d.kind === "audiooutput" && /headphone|bluetooth|earbud|headset/i.test(d.label);
      });
      if(found){
        note.textContent = "🎧 Headphones detected";
        note.classList.add("ok");
      }else{
        note.textContent = "🎧 Make sure your headphones are connected";
        note.classList.remove("ok");
      }
    }catch(e){ /* leave default hint */ }
  }

  /* ---------------- microphone routing (Bluetooth mitigation) ---------------- */
  /* Android/Chrome can auto-route the mic through a connected Bluetooth headset
     (phone-call style HFP/SCO), which is lower quality and higher latency.
     Output routing to the headphones is unaffected — this only concerns input. */
  var BT_MIC_RE = /bluetooth|hands-?free|headset|hfp|sco|airpods?|earbud|buds|wireless/i;

  function isBluetoothMicLabel(label){
    return BT_MIC_RE.test(label || "");
  }
  function activeMicTrack(stream){
    return (stream && stream.getAudioTracks()[0]) || null;
  }

  async function preferBuiltInMic(stream){
    hideMicWarning();
    try{
      var track = activeMicTrack(stream);
      if(!track || !isBluetoothMicLabel(track.label)) return stream;

      // OS picked a Bluetooth/headset mic — try to switch to a built-in one.
      var devices = await navigator.mediaDevices.enumerateDevices();
      var builtIn = devices.find(function(d){
        return d.kind === "audioinput" &&
               d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications" &&
               !isBluetoothMicLabel(d.label);
      });
      if(builtIn){
        try{
          var better = await navigator.mediaDevices.getUserMedia({
            audio:{deviceId:{exact: builtIn.deviceId}, echoCancellation:true, noiseSuppression:true}
          });
          stream.getTracks().forEach(function(t){ t.stop(); });
          stream = better;
        }catch(e){ /* keep the original stream */ }
      }

      // Labels aren't reliable on every Android build — if a Bluetooth mic is
      // still (or possibly) active, tell the user in plain language.
      var finalTrack = activeMicTrack(stream);
      if(finalTrack && isBluetoothMicLabel(finalTrack.label)){
        showMicWarning();
      }
    }catch(e){ /* best effort — never block listening over this */ }
    return stream;
  }

  function showMicWarning(){
    var el = document.getElementById("mic-warning");
    if(el) el.style.display = "flex";
  }
  function hideMicWarning(){
    var el = document.getElementById("mic-warning");
    if(el) el.style.display = "none";
  }

  /* ---------------- sliders ---------------- */
  document.getElementById("boost-slider").addEventListener("input", function(e){
    settings.boost = Number(e.target.value);
    document.getElementById("boost-value").textContent = settings.boost.toFixed(1) + "×";
    if(gainNode) gainNode.gain.value = settings.boost;
    clearActivePreset();
    saveSettings();
  });
  document.getElementById("freq-slider").addEventListener("input", function(e){
    settings.freq = Number(e.target.value);
    document.getElementById("freq-value").textContent = settings.freq + " Hz";
    if(filterNode) filterNode.frequency.value = settings.freq;
    saveSettings();
  });
  document.getElementById("db-slider").addEventListener("input", function(e){
    settings.boostDb = Number(e.target.value);
    document.getElementById("db-value").textContent = settings.boostDb + " dB";
    if(filterNode) filterNode.gain.value = settings.boostDb;
    saveSettings();
  });

  /* ---------------- presets ---------------- */
  var PRESETS = {
    quiet:  {boost:1.6, freq:2200, db:6},
    noisy:  {boost:3.0, freq:3000, db:14},
    outdoor:{boost:2.3, freq:2000, db:10}
  };
  function clearActivePreset(){
    document.querySelectorAll(".preset-btn").forEach(function(b){ b.classList.remove("active"); });
  }
  document.querySelectorAll(".preset-btn").forEach(function(btn){
    btn.addEventListener("click", function(){
      var p = PRESETS[btn.getAttribute("data-preset")];
      settings.boost = p.boost; settings.freq = p.freq; settings.boostDb = p.db;
      if(gainNode) gainNode.gain.value = p.boost;
      if(filterNode){ filterNode.frequency.value = p.freq; filterNode.gain.value = p.db; }
      currentSettingsIntoUI();
      clearActivePreset();
      btn.classList.add("active");
      saveSettings();
    });
  });

  /* ---------------- captions ---------------- */
  var recognition = null, recognitionActive = false, restartTimer = null;
  var lastFinalCaption = "";
  var currentSession = null;

  function getSpeechRecognitionClass(){
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function startCaptions(){
    var SR = getSpeechRecognitionClass();
    var box = document.getElementById("caption-box");
    var empty = document.getElementById("caption-empty");
    if(!SR){
      if(empty){ empty.textContent = "Captions aren't supported in this browser."; }
      return;
    }
    if(!navigator.onLine){
      showCaptionsOffline();
      return;
    }
    if(empty) empty.remove();

    recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || "en-US";

    recognition.onresult = function(event){
      var interim = "";
      for(var i = event.resultIndex; i < event.results.length; i++){
        var res = event.results[i];
        var text = res[0].transcript.trim();
        if(res.isFinal){
          if(text){ addFinalCaption(text); }
        } else {
          interim += text + " ";
        }
      }
      renderInterim(interim.trim());
    };
    recognition.onerror = function(e){ /* swallow; onend restarts */ };
    recognition.onend = function(){
      if(isListening){
        restartTimer = setTimeout(function(){ try{ recognition.start(); }catch(e){} }, 250);
      }
    };
    try{ recognition.start(); recognitionActive = true; }catch(e){}
  }

  function stopCaptions(){
    recognitionActive = false;
    if(restartTimer){ clearTimeout(restartTimer); restartTimer = null; }
    if(recognition){
      recognition.onend = null;
      try{ recognition.stop(); }catch(e){}
      recognition = null;
    }
  }

  function showCaptionsOffline(){
    var box = document.getElementById("caption-box");
    box.innerHTML = '<div class="caption-empty">🔌 No internet connection — captions are unavailable right now.<br><br>Your volume boost is still working normally through your headphones.</div>';
  }

  function updateNetStatus(){
    var dot = document.getElementById("net-dot");
    var text = document.getElementById("net-text");
    if(navigator.onLine){
      dot.style.color = "var(--success)";
      text.textContent = "Online";
    } else {
      dot.style.color = "var(--emergency)";
      text.textContent = "Offline — captions paused, boost still on";
    }
  }
  window.addEventListener("online", function(){
    updateNetStatus();
    if(isListening && !recognitionActive){
      var box = document.getElementById("caption-box");
      box.innerHTML = '<div class="caption-empty" id="caption-empty">Captions of what\'s said will appear here once you start.</div>';
      startCaptions();
    }
  });
  window.addEventListener("offline", function(){
    updateNetStatus();
    if(isListening){
      stopCaptions();
      showCaptionsOffline();
    }
  });
  updateNetStatus();

  function addFinalCaption(text){
    lastFinalCaption = text;
    var box = document.getElementById("caption-box");
    document.querySelectorAll(".caption-line.interim").forEach(function(n){ n.remove(); });
    var lines = box.querySelectorAll(".caption-line:not(.interim)");
    lines.forEach(function(n){ n.classList.add("old"); });
    while(box.querySelectorAll(".caption-line:not(.interim)").length > 8){
      var first = box.querySelector(".caption-line:not(.interim)");
      if(first) first.remove(); else break;
    }
    var div = document.createElement("div");
    div.className = "caption-line";
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;

    if(currentSession){
      currentSession.lines.push({t: Date.now(), text: text});
      saveSessions();
    }
  }

  function renderInterim(text){
    var box = document.getElementById("caption-box");
    var interimEl = box.querySelector(".caption-line.interim");
    if(!text){ if(interimEl) interimEl.remove(); return; }
    if(!interimEl){
      interimEl = document.createElement("div");
      interimEl.className = "caption-line interim";
      box.appendChild(interimEl);
    }
    interimEl.textContent = text;
    box.scrollTop = box.scrollHeight;
  }

  function applyCaptionSizeToDOM(){
    var box = document.getElementById("caption-box");
    box.classList.remove("cap-size-1","cap-size-2","cap-size-3","cap-size-4");
    box.classList.add("cap-size-" + (settings.captionSize || 2));
  }

  document.getElementById("btn-caption-size").addEventListener("click", function(){
    settings.captionSize = (Number(settings.captionSize || 2) % 4) + 1;
    applyCaptionSizeToDOM();
    saveSettings();
  });

  document.getElementById("btn-repeat").addEventListener("click", function(){
    var overlay = document.getElementById("repeat-overlay");
    var text = lastFinalCaption || "Nothing has been said yet.";
    overlay.textContent = text;
    overlay.classList.add("show");
    if("speechSynthesis" in window && lastFinalCaption){
      try{
        var utter = new SpeechSynthesisUtterance(text);
        utter.rate = 0.95;
        window.speechSynthesis.speak(utter);
      }catch(e){}
    }
    setTimeout(function(){ overlay.classList.remove("show"); }, 3200);
  });
  document.getElementById("repeat-overlay").addEventListener("click", function(){
    this.classList.remove("show");
  });

  /* ---------------- wake lock ---------------- */
  var wakeLock = null;
  async function requestWakeLock(){
    if(!("wakeLock" in navigator)) return;
    try{ wakeLock = await navigator.wakeLock.request("screen"); }catch(e){}
  }
  function releaseWakeLock(){
    if(wakeLock){ wakeLock.release().catch(function(){}); wakeLock = null; }
  }
  document.addEventListener("visibilitychange", async function(){
    if(document.visibilityState === "visible" && isListening && "wakeLock" in navigator){
      try{ wakeLock = await navigator.wakeLock.request("screen"); }catch(e){}
    }
  });

  /* ---------------- sessions / transcripts ---------------- */
  function beginSession(){
    currentSession = {id: Date.now().toString(36), startedAt: Date.now(), lines: []};
    sessions.unshift(currentSession);
    saveSessions();
  }

  function fmtDate(ts){
    var d = new Date(ts);
    return d.toLocaleDateString(undefined,{month:"short", day:"numeric"}) + " · " + d.toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit"});
  }

  function renderSessionsList(){
    var wrap = document.getElementById("sessions-list");
    wrap.innerHTML = "";
    var withLines = sessions.filter(function(s){ return s.lines && s.lines.length; });
    if(!withLines.length){
      wrap.innerHTML = '<div class="empty-state"><div class="emoji">📝</div><p>No conversations saved yet.<br>They will appear here after you use Start.</p></div>';
      return;
    }
    withLines.forEach(function(s){
      var card = document.createElement("div");
      card.className = "session-card";
      var preview = s.lines[0] ? s.lines[0].text : "";
      card.innerHTML = '<div class="session-date">'+fmtDate(s.startedAt)+'</div>'+
        '<div class="session-preview">'+escapeHTML(preview)+'</div>'+
        '<div class="session-count">'+s.lines.length+' line'+(s.lines.length===1?"":"s")+'</div>';
      card.addEventListener("click", function(){ openSessionDetail(s.id); });
      wrap.appendChild(card);
    });
  }

  function escapeHTML(str){
    var d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
  }

  var openSessionId = null;
  function openSessionDetail(id){
    openSessionId = id;
    var s = sessions.find(function(x){ return x.id === id; });
    if(!s) return;
    document.getElementById("detail-title").textContent = fmtDate(s.startedAt);
    var wrap = document.getElementById("detail-lines");
    wrap.innerHTML = "";
    s.lines.forEach(function(line){
      var el = document.createElement("div");
      el.className = "transcript-line";
      var t = new Date(line.t).toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit"});
      el.innerHTML = '<div class="transcript-time">'+t+'</div><div>'+escapeHTML(line.text)+'</div>';
      wrap.appendChild(el);
    });
    showView("transcript-detail");
  }

  document.getElementById("btn-transcripts").addEventListener("click", function(){
    renderSessionsList();
    showView("transcripts");
  });
  document.getElementById("btn-back-from-transcripts").addEventListener("click", function(){ showView("home"); });
  document.getElementById("btn-back-from-detail").addEventListener("click", function(){ showView("transcripts"); });

  document.getElementById("btn-copy-transcript").addEventListener("click", async function(){
    var s = sessions.find(function(x){ return x.id === openSessionId; });
    if(!s) return;
    var text = "Conversation — " + fmtDate(s.startedAt) + "\n\n" + s.lines.map(function(l){
      return new Date(l.t).toLocaleTimeString(undefined,{hour:"numeric", minute:"2-digit"}) + " — " + l.text;
    }).join("\n");
    var shared = false;
    if(navigator.share){
      try{ await navigator.share({title:"Conversation transcript", text:text}); shared = true; }catch(e){}
    }
    if(!shared){
      try{
        await navigator.clipboard.writeText(text);
        showToast("Copied to clipboard");
      }catch(e){
        showToast("Couldn't copy — try again");
      }
    }
  });

  /* ---------------- gear (setup) gating ---------------- */
  var gearBtn = document.getElementById("btn-gear");
  var holdTimer = null;
  var HOLD_MS = 1200;
  function startHold(e){
    // Capture the pointer so a long-press on Android can't cancel the hold
    // via the browser's context-menu/selection gestures.
    try{ gearBtn.setPointerCapture(e.pointerId); }catch(err){}
    gearBtn.classList.add("filling");
    gearBtn.querySelector(".fill").style.transitionDuration = HOLD_MS + "ms";
    holdTimer = setTimeout(function(){ openSetup(); cancelHold(false); }, HOLD_MS);
  }
  function cancelHold(reset){
    if(holdTimer){ clearTimeout(holdTimer); holdTimer = null; }
    gearBtn.classList.remove("filling");
    if(reset !== false){
      gearBtn.querySelector(".fill").style.transitionDuration = "0ms";
    }
  }
  gearBtn.addEventListener("pointerdown", startHold);
  gearBtn.addEventListener("pointerup", function(){ cancelHold(true); });
  gearBtn.addEventListener("pointercancel", function(){ cancelHold(true); });
  gearBtn.addEventListener("pointerleave", function(){ cancelHold(true); });
  gearBtn.addEventListener("contextmenu", function(e){ e.preventDefault(); });

  function openSetup(){
    document.getElementById("setup-boost").value = settings.boost;
    document.getElementById("setup-caption-size").value = settings.captionSize;
    document.getElementById("setup-theme").value = settings.theme;
    document.getElementById("setup-name").value = settings.emergencyName;
    document.getElementById("setup-phone").value = settings.emergencyPhone;
    setSwitch(document.getElementById("setup-advanced-switch"), settings.advanced);
    setSwitch(document.getElementById("setup-emergency-switch"), settings.showEmergency !== false);
    showView("setup");
  }
  document.getElementById("btn-back-from-setup").addEventListener("click", function(){ showView("home"); });

  function setSwitch(el, on){
    el.classList.toggle("on", !!on);
    el.dataset.on = on ? "1" : "0";
  }
  document.getElementById("setup-advanced-switch").addEventListener("click", function(){
    setSwitch(this, this.dataset.on !== "1");
  });
  document.getElementById("setup-emergency-switch").addEventListener("click", function(){
    setSwitch(this, this.dataset.on !== "1");
  });

  document.getElementById("btn-save-setup").addEventListener("click", function(){
    settings.boost = Number(document.getElementById("setup-boost").value);
    settings.captionSize = Number(document.getElementById("setup-caption-size").value);
    settings.theme = document.getElementById("setup-theme").value;
    settings.emergencyName = document.getElementById("setup-name").value.trim();
    settings.emergencyPhone = document.getElementById("setup-phone").value.trim();
    settings.advanced = document.getElementById("setup-advanced-switch").dataset.on === "1";
    settings.showEmergency = document.getElementById("setup-emergency-switch").dataset.on === "1";
    saveSettings();
    applyTheme();
    currentSettingsIntoUI();
    updateEmergencyLabel();
    showToast("Settings saved");
    showView("home");
  });

  function showToast(msg){
    var t = document.getElementById("save-toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(function(){ t.classList.remove("show"); }, 1800);
  }

  /* ---------------- screen lock ---------------- */
  /* Blocks accidental taps while listening. Captions stay visible on the
     lock screen; unlock is a deliberate press-and-hold (same gesture as the
     setup gear). The emergency button stays usable while locked. */
  var isLocked = false;
  var lockObserver = null;
  var unlockTimer = null;
  var lockHintTimer = null;

  function mirrorCaptionsToLock(){
    var box = document.getElementById("caption-box");
    var lc = document.getElementById("lock-captions");
    var size = (box.className.match(/cap-size-\d/) || [""])[0];
    lc.className = "lock-captions " + size;
    lc.innerHTML = box.innerHTML;
    lc.querySelectorAll("[id]").forEach(function(n){ n.removeAttribute("id"); });
    lc.scrollTop = lc.scrollHeight;
  }

  function lockScreen(){
    if(isLocked) return;
    isLocked = true;
    mirrorCaptionsToLock();
    lockObserver = new MutationObserver(mirrorCaptionsToLock);
    lockObserver.observe(document.getElementById("caption-box"),
      {childList:true, subtree:true, characterData:true, attributes:true});
    document.getElementById("lock-overlay").classList.add("show");
  }

  function unlockScreen(){
    if(!isLocked) return;
    isLocked = false;
    if(lockObserver){ lockObserver.disconnect(); lockObserver = null; }
    cancelUnlockHold(true);
    document.getElementById("lock-overlay").classList.remove("show");
    document.getElementById("lock-hint").classList.remove("show");
  }

  document.getElementById("btn-lock").addEventListener("click", lockScreen);

  var unlockBtn = document.getElementById("btn-unlock");
  function showLockHint(){
    var hint = document.getElementById("lock-hint");
    hint.classList.add("show");
    if(lockHintTimer) clearTimeout(lockHintTimer);
    lockHintTimer = setTimeout(function(){ hint.classList.remove("show"); }, 1600);
  }
  function startUnlockHold(e){
    try{ unlockBtn.setPointerCapture(e.pointerId); }catch(err){}
    unlockBtn.classList.add("filling");
    unlockBtn.querySelector(".fill").style.transitionDuration = HOLD_MS + "ms";
    unlockTimer = setTimeout(function(){ unlockScreen(); }, HOLD_MS);
  }
  function cancelUnlockHold(reset){
    if(unlockTimer){ clearTimeout(unlockTimer); unlockTimer = null; }
    unlockBtn.classList.remove("filling");
    if(reset !== false){
      unlockBtn.querySelector(".fill").style.transitionDuration = "0ms";
    }
  }
  unlockBtn.addEventListener("pointerdown", startUnlockHold);
  unlockBtn.addEventListener("pointerup", function(){
    // Released too early — still locked, so remind them how it works.
    if(unlockTimer) showLockHint();
    cancelUnlockHold(true);
  });
  unlockBtn.addEventListener("pointercancel", function(){ cancelUnlockHold(true); });
  unlockBtn.addEventListener("pointerleave", function(){ cancelUnlockHold(true); });
  unlockBtn.addEventListener("contextmenu", function(e){ e.preventDefault(); });

  // A stray tap anywhere on the lock screen just shows the how-to-unlock hint.
  document.getElementById("lock-overlay").addEventListener("click", function(e){
    if(e.target.closest("#btn-unlock") || e.target.closest("#btn-emergency-lock")) return;
    showLockHint();
  });

  /* ---------------- emergency ---------------- */
  function updateEmergencyLabel(){
    var name = settings.emergencyName ? settings.emergencyName : "for help";
    document.getElementById("emergency-name-label").textContent = name;
    document.getElementById("emergency-name-label-lock").textContent = name;
  }
  function applyEmergencyVisibility(){
    var show = settings.showEmergency !== false;
    document.getElementById("btn-emergency").style.display = show ? "flex" : "none";
    document.getElementById("btn-emergency-lock").style.display = show ? "flex" : "none";
  }
  function emergencyCall(){
    if(!settings.emergencyPhone){
      alert("No emergency contact is set up yet. Ask a family member to add one in Setup (hold the gear icon).");
      return;
    }
    window.location.href = "tel:" + settings.emergencyPhone.replace(/[^+\d]/g,"");
  }
  document.getElementById("btn-emergency").addEventListener("click", emergencyCall);
  document.getElementById("btn-emergency-lock").addEventListener("click", emergencyCall);

  /* ---------------- service worker (offline app shell) ---------------- */
  if("serviceWorker" in navigator){
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("sw.js").catch(function(e){ /* app still works without offline cache */ });
    });
  }

})();
