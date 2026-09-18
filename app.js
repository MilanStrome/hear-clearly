(function(){
  "use strict";

  var APP_VERSION = "6.1"; // keep in step with CACHE_VERSION in sw.js
  console.log("Hear Clearly app.js version " + APP_VERSION);

  /* ---------------- state & storage ---------------- */
  var DEFAULT_SETTINGS = {
    boost: 2, theme: "auto", advanced: false,
    emergencyName: "", emergencyPhone: "", showEmergency: true,
    freq: 2500, boostDb: 9
  };
  var settings = loadJSON("ha_settings", DEFAULT_SETTINGS);
  var onboarded = localStorage.getItem("ha_onboarded") === "1";

  function loadJSON(key, fallback){
    try{
      var raw = localStorage.getItem(key);
      if(!raw) return JSON.parse(JSON.stringify(fallback));
      return Object.assign(JSON.parse(JSON.stringify(fallback)), JSON.parse(raw));
    }catch(e){ return JSON.parse(JSON.stringify(fallback)); }
  }
  function saveSettings(){ try{ localStorage.setItem("ha_settings", JSON.stringify(settings)); }catch(e){} }

  function applyTheme(){
    var root = document.documentElement;
    if(settings.theme === "light") root.setAttribute("data-theme","light");
    else if(settings.theme === "dark") root.setAttribute("data-theme","dark");
    else root.removeAttribute("data-theme");
  }
  applyTheme();

  /* ---------------- view switching ---------------- */
  var views = {};
  ["onboard","home","setup"].forEach(function(id){
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
  var audioCtx = null, micStream = null, sourceNode = null, gainNode = null, filterNode = null, analyserNode = null, compressorNode = null;
  var hpfNode = null, gateNode = null, gateAnalyser = null;
  var isListening = false;
  var noiseRAF = null;

  /* Noise gate: ducks the output ~85% when the (pre-boost) level sits at the
     mic's hiss floor — quiet between sentences — and reopens the instant
     speech starts. Fast open so word starts aren't clipped, slow close so it
     doesn't flutter, and it ducks rather than hard-mutes. */
  var GATE_OPEN_RMS = 0.012, GATE_CLOSE_RMS = 0.006, GATE_CLOSE_HOLD_MS = 400, GATE_FLOOR = 0.15;
  var gateTimer = null, gateOpen = true, gateBelowSince = 0;

  function startNoiseGate(){
    var data = new Float32Array(gateAnalyser.fftSize);
    gateOpen = true; gateBelowSince = 0;
    gateTimer = setInterval(function(){
      if(!isListening || !gateAnalyser || !gateNode || !audioCtx) return;
      gateAnalyser.getFloatTimeDomainData(data);
      var sum = 0;
      for(var i=0;i<data.length;i++) sum += data[i]*data[i];
      var rms = Math.sqrt(sum/data.length);
      var now = Date.now();
      if(rms >= GATE_OPEN_RMS){
        gateBelowSince = 0;
        if(!gateOpen){
          gateOpen = true;
          gateNode.gain.setTargetAtTime(1, audioCtx.currentTime, 0.01);
        }
      } else if(rms < GATE_CLOSE_RMS){
        if(!gateBelowSince) gateBelowSince = now;
        if(gateOpen && (now - gateBelowSince) >= GATE_CLOSE_HOLD_MS){
          gateOpen = false;
          gateNode.gain.setTargetAtTime(GATE_FLOOR, audioCtx.currentTime, 0.15);
        }
      }
      /* between the two thresholds: hysteresis — hold the current state */
    }, 50);
  }
  function stopNoiseGate(){ if(gateTimer){ clearInterval(gateTimer); gateTimer = null; } }

  // These are the settings that reliably produce audible output on Android;
  // disabling echoCancellation made several devices go fully silent (Chrome
  // routes the audio differently without it). Clipping distortion is handled
  // by the limiter in the chain instead.
  var MIC_CONSTRAINTS = {echoCancellation:true, noiseSuppression:true, autoGainControl:true};

  // Android quirk: WebAudio output from a mic stream can stay silent unless
  // the stream is also attached to a (muted) media element.
  var keepAliveAudio = null;
  function attachKeepAlive(stream){
    try{
      if(!keepAliveAudio){ keepAliveAudio = new Audio(); keepAliveAudio.muted = true; }
      keepAliveAudio.srcObject = stream;
      var p = keepAliveAudio.play();
      if(p && p.catch) p.catch(function(){});
    }catch(e){}
  }
  function releaseKeepAlive(){
    try{
      if(keepAliveAudio){ keepAliveAudio.pause(); keepAliveAudio.srcObject = null; }
    }catch(e){}
  }

  function currentSettingsIntoUI(){
    document.getElementById("boost-slider").value = settings.boost;
    document.getElementById("boost-value").textContent = Number(settings.boost).toFixed(1) + "×";
    document.getElementById("freq-slider").value = settings.freq;
    document.getElementById("freq-value").textContent = settings.freq + " Hz";
    document.getElementById("db-slider").value = settings.boostDb;
    document.getElementById("db-value").textContent = settings.boostDb + " dB";
    document.getElementById("advanced-controls").style.display = settings.advanced ? "flex" : "none";
    document.getElementById("simple-controls").style.display = "flex";
    updateEmergencyLabel();
    applyEmergencyVisibility();
  }
  currentSettingsIntoUI();

  async function startListening(){
    try{
      micStream = await navigator.mediaDevices.getUserMedia({audio: MIC_CONSTRAINTS});
    }catch(err){
      alert("This app needs microphone access to work. Please allow microphone access and try again.");
      return;
    }
    micStream = await preferBuiltInMic(micStream);
    attachKeepAlive(micStream);
    var AC = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AC();
    if(audioCtx.state === "suspended"){ try{ await audioCtx.resume(); }catch(e){} }

    sourceNode = audioCtx.createMediaStreamSource(micStream);

    // Rumble filter: cuts hum, AC rumble and handling noise below speech.
    hpfNode = audioCtx.createBiquadFilter();
    hpfNode.type = "highpass";
    hpfNode.frequency.value = 120;

    // Pre-boost level tap for the noise gate (independent of the boost slider).
    gateAnalyser = audioCtx.createAnalyser();
    gateAnalyser.fftSize = 256;

    gateNode = audioCtx.createGain();
    gateNode.gain.value = 1;

    gainNode = audioCtx.createGain();
    gainNode.gain.value = Number(settings.boost);

    filterNode = audioCtx.createBiquadFilter();
    filterNode.type = "peaking";
    filterNode.frequency.value = Number(settings.freq);
    filterNode.Q.value = 1.0;
    filterNode.gain.value = Number(settings.boostDb);

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 512;

    // Limiter: stops loud speech from clipping into harsh distortion
    // now that the gain and EQ boost can push peaks past full scale.
    compressorNode = audioCtx.createDynamicsCompressor();
    compressorNode.threshold.value = -12;
    compressorNode.knee.value = 12;
    compressorNode.ratio.value = 12;
    compressorNode.attack.value = 0.003;
    compressorNode.release.value = 0.25;

    sourceNode.connect(hpfNode);
    hpfNode.connect(gateAnalyser);
    hpfNode.connect(gainNode);
    gainNode.connect(filterNode);
    filterNode.connect(analyserNode);
    filterNode.connect(gateNode);
    gateNode.connect(compressorNode);
    compressorNode.connect(audioCtx.destination);
    startNoiseGate();

    isListening = true;
    showToast("Listening — speak normally");
    document.getElementById("stage").classList.add("listening");
    document.getElementById("listen-icon").textContent = "⏸️";
    document.getElementById("listen-label").textContent = "Stop";
    document.getElementById("status-dot").classList.add("on");
    document.getElementById("status-text").textContent = "Listening";
    checkHeadphoneHint();
    startNoiseMeter();
    requestWakeLock();
    var lb = document.getElementById("btn-lock");
    if(lb) lb.style.display = "flex";
    watchForSilentMic();
  }

  /* Some Android devices deliver a silent stream in unusual configurations.
     Watch the first ~3s of a session: a real mic never flatlines exactly at
     zero (even a quiet room has noise-floor wobble). If it does, re-request
     the mic with the browser's default settings and swap it in. */
  var silenceCheckTimer = null;
  function watchForSilentMic(){
    if(silenceCheckTimer) clearTimeout(silenceCheckTimer);
    var checks = 0, flatlines = 0;
    var data = new Uint8Array(512);
    function sample(){
      if(!isListening || !analyserNode) return;
      analyserNode.getByteTimeDomainData(data);
      var maxDev = 0;
      for(var i=0;i<data.length;i++){
        var d = Math.abs(data[i] - 128);
        if(d > maxDev) maxDev = d;
      }
      if(maxDev <= 1) flatlines++;
      checks++;
      if(checks < 12){ silenceCheckTimer = setTimeout(sample, 250); return; }
      if(flatlines >= 11) fallbackToDefaultMic();
    }
    silenceCheckTimer = setTimeout(sample, 400);
  }

  async function fallbackToDefaultMic(){
    if(!isListening) return;
    try{
      var basic = await navigator.mediaDevices.getUserMedia({audio:true});
      if(!isListening){ basic.getTracks().forEach(function(t){ t.stop(); }); return; }
      if(sourceNode){ try{ sourceNode.disconnect(); }catch(e){} }
      if(micStream){ micStream.getTracks().forEach(function(t){ t.stop(); }); }
      micStream = basic;
      attachKeepAlive(micStream);
      sourceNode = audioCtx.createMediaStreamSource(micStream);
      sourceNode.connect(hpfNode);
      showToast("Microphone adjusted");
    }catch(e){ /* keep whatever we have */ }
  }

  function stopListening(){
    isListening = false;
    document.getElementById("stage").classList.remove("listening");
    document.getElementById("listen-icon").textContent = "🎙️";
    document.getElementById("listen-label").textContent = "Start";
    document.getElementById("status-dot").classList.remove("on");
    document.getElementById("status-text").textContent = "Not listening";
    stopNoiseMeter();
    stopNoiseGate();
    releaseWakeLock();
    hideMicWarning();
    if(silenceCheckTimer){ clearTimeout(silenceCheckTimer); silenceCheckTimer = null; }
    var lb = document.getElementById("btn-lock");
    if(lb) lb.style.display = "none";
    unlockScreen(); // never leave the lock up when listening has ended
    releaseKeepAlive();
    if(micStream){ micStream.getTracks().forEach(function(t){ t.stop(); }); micStream = null; }
    if(audioCtx){ audioCtx.close().catch(function(){}); audioCtx = null; }
    compressorNode = null; hpfNode = null; gateNode = null; gateAnalyser = null;
    document.getElementById("noise-fill").style.width = "0%";
  }

  document.getElementById("btn-listen").addEventListener("click", function(){
    if(isListening){
      stopListening();
      showToast("Stopped");
    } else {
      showToast("Starting — allow the microphone if asked");
      startListening();
    }
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
            audio: Object.assign({deviceId:{exact: builtIn.deviceId}}, MIC_CONSTRAINTS)
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
    document.getElementById("setup-theme").value = settings.theme;
    document.getElementById("setup-name").value = settings.emergencyName;
    document.getElementById("setup-phone").value = settings.emergencyPhone;
    setSwitch(document.getElementById("setup-advanced-switch"), settings.advanced);
    setSwitch(document.getElementById("setup-emergency-switch"), settings.showEmergency !== false);
    showView("setup");
  }

  // Live preview: changing the appearance dropdown applies instantly so the
  // caregiver sees the effect; leaving without saving restores the saved theme.
  document.getElementById("setup-theme").addEventListener("change", function(){
    var v = this.value;
    var root = document.documentElement;
    if(v === "light") root.setAttribute("data-theme","light");
    else if(v === "dark") root.setAttribute("data-theme","dark");
    else root.removeAttribute("data-theme");
  });
  document.getElementById("btn-back-from-setup").addEventListener("click", function(){
    applyTheme(); // revert any unsaved theme preview
    showView("home");
  });

  function setSwitch(el, on){
    if(!el) return;
    el.classList.toggle("on", !!on);
    el.dataset.on = on ? "1" : "0";
  }
  document.getElementById("setup-advanced-switch").addEventListener("click", function(){
    setSwitch(this, this.dataset.on !== "1");
  });
  var emSwitch = document.getElementById("setup-emergency-switch");
  if(emSwitch) emSwitch.addEventListener("click", function(){
    setSwitch(this, this.dataset.on !== "1");
  });

  document.getElementById("btn-save-setup").addEventListener("click", function(){
    settings.boost = Number(document.getElementById("setup-boost").value);
    settings.theme = document.getElementById("setup-theme").value;
    settings.emergencyName = document.getElementById("setup-name").value.trim();
    settings.emergencyPhone = document.getElementById("setup-phone").value.trim();
    settings.advanced = document.getElementById("setup-advanced-switch").dataset.on === "1";
    var emSw = document.getElementById("setup-emergency-switch");
    if(emSw) settings.showEmergency = emSw.dataset.on === "1";
    saveSettings();
    applyTheme();
    currentSettingsIntoUI();
    showToast("Settings saved");
    showView("home");
  });

  var toastTimer = null;
  function showToast(msg){
    var t = document.getElementById("save-toast");
    t.textContent = msg;
    t.classList.add("show");
    if(toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ t.classList.remove("show"); }, 1800);
  }

  /* ---------------- screen lock ---------------- */
  /* Blocks accidental taps while listening. Unlock is a deliberate
     press-and-hold (same gesture as the setup gear). The emergency button
     stays usable while locked. */
  var isLocked = false;
  var unlockTimer = null;
  var lockHintTimer = null;

  var lockBtn = document.getElementById("btn-lock");
  var lockOverlayEl = document.getElementById("lock-overlay");
  var unlockBtn = document.getElementById("btn-unlock");
  var lockSupported = !!(lockBtn && lockOverlayEl && unlockBtn);

  function lockScreen(){
    if(!lockSupported || isLocked) return;
    isLocked = true;
    lockOverlayEl.classList.add("show");
  }

  function unlockScreen(){
    if(!isLocked) return;
    isLocked = false;
    cancelUnlockHold(true);
    lockOverlayEl.classList.remove("show");
    var hint = document.getElementById("lock-hint");
    if(hint) hint.classList.remove("show");
  }

  function showLockHint(){
    var hint = document.getElementById("lock-hint");
    if(!hint) return;
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
  if(lockSupported){
    lockBtn.addEventListener("click", lockScreen);
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
    lockOverlayEl.addEventListener("click", function(e){
      if(e.target.closest("#btn-unlock") || e.target.closest("#btn-emergency-lock")) return;
      showLockHint();
    });
  }

  /* ---------------- emergency ---------------- */
  function updateEmergencyLabel(){
    var name = settings.emergencyName ? settings.emergencyName : "for help";
    var l1 = document.getElementById("emergency-name-label");
    var l2 = document.getElementById("emergency-name-label-lock");
    if(l1) l1.textContent = name;
    if(l2) l2.textContent = name;
  }
  function applyEmergencyVisibility(){
    var show = settings.showEmergency !== false;
    var b1 = document.getElementById("btn-emergency");
    var b2 = document.getElementById("btn-emergency-lock");
    var b3 = document.getElementById("btn-emergency-top");
    if(b1) b1.style.display = show ? "flex" : "none";
    if(b2) b2.style.display = show ? "flex" : "none";
    if(b3) b3.style.display = show ? "flex" : "none";
  }
  function emergencyCall(){
    if(!settings.emergencyPhone){
      alert("No emergency contact is set up yet. Ask a family member to add one in Setup (hold the gear icon).");
      return;
    }
    window.location.href = "tel:" + settings.emergencyPhone.replace(/[^+\d]/g,"");
  }
  var emBtn = document.getElementById("btn-emergency");
  var emBtnLock = document.getElementById("btn-emergency-lock");
  var emBtnTop = document.getElementById("btn-emergency-top");
  if(emBtn) emBtn.addEventListener("click", emergencyCall);
  if(emBtnLock) emBtnLock.addEventListener("click", emergencyCall);
  if(emBtnTop) emBtnTop.addEventListener("click", emergencyCall);

  /* ---------------- service worker (offline app shell) ---------------- */
  if("serviceWorker" in navigator){
    window.addEventListener("load", function(){
      navigator.serviceWorker.register("sw.js").catch(function(e){ /* app still works without offline cache */ });
    });
  }

})();
