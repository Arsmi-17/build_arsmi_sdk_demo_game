(function () {
  "use strict";

  var BRIDGE_INIT = "gamehub:bridge:init";
  var BRIDGE_READY = "gamehub:bridge:ready";
  var BRIDGE_EVENT = "gamehub:bridge:event";
  var BRIDGE_LOG = "gamehub:bridge:log";

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function GameHubSDK(options) {
    options = options || {};
    this.sessionId = null;
    this.targetOrigin = options.targetOrigin || "*";
    this.debug = !!options.debug;
    this.capabilities = {
      challenge: !!(options.capabilities && options.capabilities.challenge),
      pocketConsole: !!(options.capabilities && options.capabilities.pocketConsole),
      fullscreen: !options.capabilities || options.capabilities.fullscreen !== false,
      mute: !options.capabilities || options.capabilities.mute !== false,
      achievements: !options.capabilities || options.capabilities.achievements !== false,
      leaderboard: !options.capabilities || options.capabilities.leaderboard !== false,
    };
    this.handlers = {};
    this.destroyed = false;
    this.context = { preview: false };
    this._onMessage = this._onMessage.bind(this);
    window.addEventListener("message", this._onMessage);

    var self = this;
    this.challenge = {
      ready: function (payload) { self.emit("gamehub:challenge:ready", payload || {}); },
      updateState: function (payload) { self.emit("gamehub:challenge:state", payload || {}); },
      submitResult: function (payload) { self.emit("gamehub:challenge:result", payload || {}); },
      onStart: function (handler) { return self.on("gamehub:challenge:start", handler); },
      onLeaderboard: function (handler) { return self.on("gamehub:challenge:leaderboard", handler); },
      onEnd: function (handler) { return self.on("gamehub:challenge:end", handler); },
    };
    this.pocket = {
      ready: function (payload) { self.emit("gamehub:pocket:ready", payload || {}); },
      setControllerSchema: function (payload) { self.emit("gamehub:pocket:schema", payload || {}); },
      onInput: function (handler) { return self.on("gamehub:pocket:input", handler); },
      onPlayerJoined: function (handler) { return self.on("gamehub:pocket:player_joined", handler); },
      onPlayerReconnected: function (handler) { return self.on("gamehub:pocket:player_reconnected", handler); },
      onPlayerLeft: function (handler) { return self.on("gamehub:pocket:player_left", handler); },
    };
    this.achievements = {
      define: function (payload) { self.emit("gamehub:achievements:manifest", payload || {}); },
      progress: function (payload) { self.emit("gamehub:achievement:progress", payload || {}); },
      onSharing: function (handler) { return self.on("gamehub:achievements:sharing", handler); },
    };
    this.leaderboard = {
      define: function (payload) { self.emit("gamehub:leaderboard:define", payload || {}); },
      submitScore: function (payload) { self.emit("gamehub:leaderboard:score", payload || {}); },
      onSharing: function (handler) { return self.on("gamehub:leaderboard:sharing", handler); },
    };

    // ---- Save data -------------------------------------------------------
    // The game stays the source of truth: it saves locally as it always did, and
    // this mirrors the map to the player's account so progress follows them to
    // another device.
    this._save = {
      cache: {},            // the map the game reads and writes, synchronously
      rev: 0,               // last rev the platform confirmed; we send rev + 1
      loaded: false,
      mode: "no",
      loggedIn: false,
      flushTimer: null,
      lastSentHash: null,   // dirty check: skip a flush that would change nothing
      pending: null,        // resolve fns for flush() callers
      readyResolvers: [],
    };
    this.on("gamehub:data:state", function (payload) { self._onDataState(payload); });
    this.on("gamehub:data:error", function (payload) {
      var message = (payload && payload.message) || "Save failed.";
      if (console && console.warn) console.warn("[GameHubSDK] data: " + message);
      self._dispatch("gamehub:data:failed", { message: message });
    });

    this.data = {
      getItem: function (key) {
        var value = self._save.cache[String(key)];
        return typeof value === "string" ? value : null;
      },
      setItem: function (key, value) {
        if (!self._requireSaveMode()) return;
        self._save.cache[String(key)] = String(value);
        self._scheduleFlush();
      },
      removeItem: function (key) {
        if (!self._requireSaveMode()) return;
        delete self._save.cache[String(key)];
        self._scheduleFlush();
      },
      keys: function () { return Object.keys(self._save.cache); },
      getAll: function () { return Object.assign({}, self._save.cache); },
      clear: function () {
        if (!self._requireSaveMode()) return;
        self._save.cache = {};
        self.emit("gamehub:data:clear", {});
      },
      flush: function () { return self._flush(true); },
      onChange: function (handler) { return self.on("gamehub:data:changed", handler); },
      isReady: function () { return self._save.loaded; },
    };

    // ---- Ads -------------------------------------------------------------
    // The ad is a PLATFORM overlay. The game never renders it, never times it, and
    // never decides whether it was watched — the reward is real currency, so that
    // call stays outside the iframe. The game asks, pauses itself, and waits.
    this._ad = { pending: null };
    this.on("gamehub:ad:state", function (payload) {
      payload = payload || {};
      var status = String(payload.status || "");
      if (status === "started") {
        self._dispatch("gamehub:ad:started", payload);
        return;
      }
      var resolve = self._ad.pending;
      self._ad.pending = null;
      var result = {
        rewarded: status === "rewarded",
        balance: typeof payload.balance === "number" ? payload.balance : null,
        reason: payload.reason || null,
      };
      self._dispatch("gamehub:ad:finished", result);
      if (resolve) resolve(result);
    });

    this.ads = {
      /**
       * Shows a rewarded ad and resolves with { rewarded, balance }.
       * `rewarded: false` means the player skipped it or it failed — do not pay out.
       */
      showRewarded: function (payload) {
        if (self._ad.pending) return Promise.resolve({ rewarded: false, reason: "already-showing" });
        self.emit("gamehub:ad:show", Object.assign({ type: "rewarded" }, payload || {}));
        return new Promise(function (resolve) { self._ad.pending = resolve; });
      },
      onStarted: function (handler) { return self.on("gamehub:ad:started", handler); },
      onFinished: function (handler) { return self.on("gamehub:ad:finished", handler); },
    };

    this.user = {
      get: function () {
        return Object.assign({ loggedIn: self._save.loggedIn }, self._user || {});
      },
      onChange: function (handler) { return self.on("gamehub:user:state", handler); },
    };
    this.on("gamehub:user:state", function (payload) {
      self._user = payload || {};
      self._save.loggedIn = !!(payload && payload.loggedIn);
    });

    // Closing the tab must not cost the player the last few seconds of play.
    // A debounced flush is still pending at that moment, so force it out now.
    // visibilitychange->hidden is the only event mobile browsers reliably fire.
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") self._flush(false);
      });
    }
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", function () { self._flush(false); });
    }
  }

  /** Resolves once the platform has handed us the player's save. */
  GameHubSDK.prototype.init = function () {
    var self = this;
    if (this._save.loaded) return Promise.resolve(this.data.getAll());
    return new Promise(function (resolve) {
      self._save.readyResolvers.push(resolve);
      // Ask, in case the unprompted push at bridge init already went by.
      self.emit("gamehub:data:get", {});
    });
  };

  GameHubSDK.prototype._requireSaveMode = function () {
    if (this._save.mode === "sdk") return true;
    if (console && console.warn) {
      console.warn(
        "[GameHubSDK] This game is not published with platform save enabled, so data.* is a no-op. " +
        "Set \"Save progress\" to the Data Module option when you publish."
      );
    }
    return false;
  };

  GameHubSDK.prototype._hash = function (map) {
    // Stable: key order must not change the result, or every flush looks dirty
    // and the check buys nothing. JSON-encoding each pair keeps the delimiters
    // unambiguous, so {"a b":"c"} and {"a":"b c"} cannot collide.
    var keys = Object.keys(map).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      parts.push(JSON.stringify(keys[i]) + ":" + JSON.stringify(map[keys[i]]));
    }
    return parts.join(",");
  };

  GameHubSDK.prototype._scheduleFlush = function () {
    var self = this;
    if (this._save.flushTimer) return;
    // A game calling setItem in its update loop must not produce a request per
    // frame; coalesce the burst into one write.
    this._save.flushTimer = setTimeout(function () { self._flush(false); }, 1000);
  };

  GameHubSDK.prototype._flush = function (force) {
    var self = this;
    if (this._save.flushTimer) {
      clearTimeout(this._save.flushTimer);
      this._save.flushTimer = null;
    }
    if (this._save.mode !== "sdk") return Promise.resolve(false);

    var hash = this._hash(this._save.cache);
    // Most "save every 30s" games spend that time in a menu writing identical
    // data. Skipping the unchanged flush removes most writes for free.
    if (!force && hash === this._save.lastSentHash) return Promise.resolve(false);
    this._save.lastSentHash = hash;

    this.emit("gamehub:data:set", {
      data: Object.assign({}, this._save.cache),
      rev: this._save.rev + 1,
    });

    return new Promise(function (resolve) { self._save.pending = resolve; });
  };

  GameHubSDK.prototype._onDataState = function (payload) {
    payload = payload || {};
    var save = this._save;
    var incomingRev = Number(payload.rev);
    if (typeof payload.mode === "string") save.mode = payload.mode;
    if (typeof payload.loggedIn === "boolean") save.loggedIn = payload.loggedIn;

    var changed = false;
    if (isObject(payload.data)) {
      var next = payload.data;
      // The platform is authoritative here. This fires when the save first
      // arrives, after a guest map is merged up on login, or when our own write
      // was rejected as stale because another device is ahead of us — in every
      // case adopting it is right, and keeping our copy would roll the player back.
      if (this._hash(next) !== this._hash(save.cache)) changed = true;
      save.cache = Object.assign({}, next);
      save.lastSentHash = this._hash(save.cache);
    }
    if (Number.isFinite(incomingRev) && incomingRev >= 0) save.rev = incomingRev;

    var wasLoaded = save.loaded;
    save.loaded = true;

    if (save.pending) {
      var resolve = save.pending;
      save.pending = null;
      resolve(true);
    }

    if (!wasLoaded) {
      var resolvers = save.readyResolvers.slice();
      save.readyResolvers = [];
      var all = this.data.getAll();
      resolvers.forEach(function (fn) { fn(all); });
    }

    if (changed && wasLoaded) this._dispatch("gamehub:data:changed", this.data.getAll());
  };

  GameHubSDK.create = function (options) {
    return new GameHubSDK(options);
  };

  GameHubSDK.prototype.destroy = function () {
    this.destroyed = true;
    this.handlers = {};
    window.removeEventListener("message", this._onMessage);
  };

  GameHubSDK.prototype.on = function (type, handler) {
    if (!this.handlers[type]) this.handlers[type] = [];
    this.handlers[type].push(handler);
    var list = this.handlers[type];
    return function () {
      var index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  };

  GameHubSDK.prototype.emit = function (event, payload) {
    this._send(BRIDGE_EVENT, { event: event, name: event, payload: payload || {} });
  };

  GameHubSDK.prototype.log = function (level, message, data) {
    this._send(BRIDGE_LOG, { level: level, message: message, data: data || null });
  };

  GameHubSDK.prototype.requestPlatformFullscreen = function (orientation) {
    this.emit("fullscreen_request", { orientation: orientation || "auto" });
  };

  GameHubSDK.prototype.setMuted = function (muted) {
    this.emit("audio_muted", { muted: !!muted });
  };

  GameHubSDK.prototype.requestLogin = function (reason) {
    this.emit("gamehub:auth:login", { reason: reason || "game" });
  };

  GameHubSDK.prototype.getSessionId = function () {
    return this.sessionId;
  };

  GameHubSDK.prototype.getContext = function () {
    return Object.assign({}, this.context);
  };

  GameHubSDK.prototype.isPreview = function () {
    return !!(this.context && this.context.preview);
  };

  GameHubSDK.prototype.onContext = function (handler) {
    var unsubscribe = this.on("gamehub:context", handler);
    handler(this.getContext());
    return unsubscribe;
  };

  GameHubSDK.prototype._onMessage = function (event) {
    var data = event.data;
    if (this.destroyed || !isObject(data) || typeof data.type !== "string") return;
    if (data.type === BRIDGE_INIT) {
      if (typeof data.sessionId === "string") this.sessionId = data.sessionId;
      this.context = {
        role: typeof data.role === "string" ? data.role : this.context.role,
        preview: data.preview === true || data.role === "dashboard-preview",
        sessionId: this.sessionId || undefined,
        gameId: typeof data.gameId === "string" ? data.gameId : undefined,
        slug: typeof data.slug === "string" ? data.slug : undefined,
        embedType: typeof data.embedType === "string" ? data.embedType : undefined,
        orientation: typeof data.orientation === "string" ? data.orientation : undefined,
        testUser: isObject(data.testUser)
          ? {
              id: String(data.testUser.id || "preview-user"),
              username: typeof data.testUser.username === "string" ? data.testUser.username : undefined,
              displayName: typeof data.testUser.displayName === "string" ? data.testUser.displayName : undefined,
              email: typeof data.testUser.email === "string" ? data.testUser.email : null,
              test: data.testUser.test === true,
              local: data.testUser.local === true,
            }
          : undefined,
      };
      this._send(BRIDGE_READY, {
        sdk: "@gamehub/sdk",
        version: "0.1.0",
        capabilities: this.capabilities,
        preview: this.context.preview,
      });
      this._dispatch("gamehub:context", this.getContext());
      this.log("info", "GameHub SDK ready");
      return;
    }
    var eventType = data.type === BRIDGE_EVENT && typeof data.event === "string" ? data.event : data.type;
    var payload = data.type === BRIDGE_EVENT && isObject(data.payload) ? data.payload : data;
    this._dispatch(eventType, payload);
  };

  GameHubSDK.prototype._dispatch = function (type, payload) {
    if (this.debug && console && console.debug) console.debug("[GameHubSDK] recv", type, payload);
    var list = this.handlers[type] || [];
    list.slice().forEach(function (handler) { handler(payload); });
  };

  GameHubSDK.prototype._send = function (type, payload) {
    if (!window.parent) return;
    var message = Object.assign({ type: type, sessionId: this.sessionId || undefined }, payload || {});
    if (this.debug && console && console.debug) console.debug("[GameHubSDK] send", message);
    window.parent.postMessage(message, this.targetOrigin);
  };

  window.GameHubSDK = GameHubSDK;
  window.GameHubBridge = window.GameHubBridge || GameHubSDK.create({
    debug: false,
      capabilities: { challenge: true, pocketConsole: true, fullscreen: true, mute: true, achievements: true, leaderboard: true },
    });
})();
