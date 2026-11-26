// Fake Blink backend for tests/activity_harness.html. Loaded right after jQuery and
// before the app's scripts: seeds a saved login, answers $.ajax with canned Blink
// responses, opens the Activity pane and reports what it drew in #test-result.
(function()
{
    var params = new URLSearchParams(location.search);
    var fixtureName = params.get("fixture") || "empty";
    var action = params.get("action");  // "download": click every local clip's download icon;
                                        // "signout": click Sign out, then report the login form;
                                        // "cameras": stay on the cameras and report their cards;
                                        // "locations": on Activity, click each location tab
    var mode = params.get("mode");      // "login": no saved session; check the login form
    var proxy = params.get("proxy");    // "public": bling-proxy.py run with BLING_PUBLIC=1
    var lastUser = params.get("lastuser");  // the email this browser last signed in with
    var report = {fixture: fixtureName, requests: [], toasts: [], errors: [], downloads: []};

    // Record downloads (<a download> clicks) instead of saving files.
    var anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function()
    {
        if(this.hasAttribute("download")) report.downloads.push({name: this.download, href: this.href.split(":")[0]});
        else anchorClick.call(this);
    };

    window.addEventListener("error", function(e) { report.errors.push(String(e.message)); });
    var consoleError = console.error;
    console.error = function() { report.errors.push("console.error: " + JSON.stringify([].slice.call(arguments))); consoleError.apply(console, arguments); };

    var clip = function(id, minutesAgo, name)
    {
        return {
            id: id, created_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
            updated_at: new Date().toISOString(), deleted: false, device: "camera", device_id: 10,
            device_name: name, network_id: 1, network_name: "Home", type: "video", source: "pir",
            watched: false, partial: false,
            thumbnail: "/api/v2/accounts/1/media/thumb/" + id,
            media: "/api/v2/accounts/1/media/clip/" + id + ".mp4"
        };
    };

    // cloud: page 1 of media/changed (null = HTTP 500); local: Sync Module local storage behaviour.
    var noCloud = {media: []};  // with the defaults below, exactly what Blink returned for an account without cloud clips
    var fixtures = {
        empty: {cloud: noCloud},
        clips: {cloud: {media: [clip(101, 5, "Front door"), clip(102, 60, "Front door"), clip(103, 120, "Laundry")]}},
        deleted: {cloud: {media: [$.extend(clip(104, 5, "Front door"), {deleted: true})]}},
        nomedia: {cloud: {message: "unexpected"}},
        error500: {cloud: null},
        local: {cloud: noCloud, local: "clips"},          // local storage only (the real-world case)
        localbusy: {cloud: noCloud, local: "busy"},       // module busy: manifest not ready on first fetch
        localempty: {cloud: noCloud, local: "empty"},
        localfail: {cloud: noCloud, local: "fail"},       // manifest command fails
        mixed: {cloud: {media: [clip(101, 5, "Front door"), clip(103, 120, "Laundry")]}, local: "clips"},
        // Two locations; the third ("Barn") has no clips.
        locations: {cloud: {media: [clip(101, 5, "Front door"), $.extend(clip(201, 20, "Dock"), {network_id: 2, network_name: "Cabin"}),
                                    clip(103, 120, "Laundry")]}, local: "clips",
                    networks: [{network_id: 1, name: "Home"}, {network_id: 2, name: "Cabin"}, {network_id: 3, name: "Barn"}]}
    };
    var fixture = fixtures[fixtureName];
    var mediaPage1 = fixture.cloud;
    var calls = {};
    var count = function(key) { return calls[key] = (calls[key] || 0) + 1; };
    var minutesAgo = function(n) { return new Date(Date.now() - n * 60000).toISOString(); };
    var LS = "/api/v1/accounts/1/networks/1/sync_modules/5/local_storage";

    var routes = [
        [/\/user$/, {email: "test@example.com", temp_units: "f"}],
        [/\/api\/v1\/camera\/usage$/, {networks: fixture.networks || [{network_id: 1, name: "Home",
            cameras: [{id: 10, name: "Front door"}, {id: 11, name: "Laundry"}]}]}],
        [/\/network\/[23]$/, {devicestatus: []}],
        [/\/api\/v3\/accounts\/1\/homescreen$/, {cameras: [{id: 10, name: "Front door", type: "catalina", serial: "A1"},
            {id: 11, name: "Laundry", type: "catalina", serial: "A2"}], owls: [], doorbells: [],
            sync_modules: fixture.local ? [
                {id: 5, network_id: 1, local_storage_enabled: true, local_storage_compatible: true, local_storage_status: "active"},
                {id: 6, network_id: 2, local_storage_enabled: false, local_storage_compatible: true, local_storage_status: "inactive"}
            ] : [{id: 5, network_id: 1, local_storage_enabled: false, local_storage_compatible: true, local_storage_status: "inactive"}]}],
        // --- Sync Module local storage ---
        ["POST", new RegExp(LS + "/manifest/request$"), function()
        {
            return fixture.local == "fail" ? {id: 899, network_id: 1} : {id: 900, network_id: 1};
        }],
        [/\/network\/1\/command\/899$/, {complete: false, status_code: 999}],
        [/\/network\/1\/command\/(900|901)$/, function(m)
        {
            return {complete: count("command" + m[1]) > 1, status_code: 908};  // not done on the first poll
        }],
        ["GET", new RegExp(LS + "/manifest/request/900$"), function()
        {
            if(fixture.local == "busy" && count("manifest") == 1) return {};
            if(fixture.local == "empty") return {manifest_id: 77, clips: []};
            return {manifest_id: 77, clips: [
                {id: "5001", camera_name: "Frontdoor", created_at: minutesAgo(30), size: "1048576"},
                {id: "5002", camera_name: "Laundry", created_at: minutesAgo(10), size: "2097152"}]};
        }],
        ["POST", new RegExp(LS + "/manifest/77/clip/request/(\\d+)$"), {id: 901, network_id: 1}],
        ["GET", new RegExp(LS + "/manifest/77/clip/request/(\\d+)$"), function()
        {
            return new Blob(["fake mp4"], {type: "video/mp4"});
        }],
        [/\/network\/1\/camera\/(\d+)$/, function(m) { return {camera_status: {camera_id: +m[1], network_id: 1,
            thumbnail: "1700000000", temperature: 60, battery_state: "ok", updated_at: new Date().toISOString()}}; }],
        [/\/network\/1$/, {network: {id: 1, name: "Home"}, devicestatus: [{id: 10, name: "Front door", type: "white"}]}],
        [/\/media\/changed\?.*page=(\d+)$/, function(m)
        {
            if(m[1] != "1") return {media: []};
            if(mediaPage1 === null) return {status: 500, body: {message: "Internal Server Error"}};
            return $.extend({limit: 200, purge_id: 15952242263, refresh_count: 0}, mediaPage1);
        }],
        ["GET", /^auth\/last-login$/, proxy == "public" ? {public: true} : {email: "test@example.com"}],
        [/\/(thumbnail|thumb)\b/, ""],
        [/\/media\/clip\//, ""]
    ];

    if(lastUser) localStorage.setItem("bling.lastUser", lastUser);
    if(action == "signout" && sessionStorage.getItem("bling.test.signedOut"))
    {
        mode = "login";  // the reload after Sign out: keep what it left
        report.signedOut = true;
        report.tokenAfterSignOut = JSON.parse(localStorage.getItem("bling.token"));
    }
    else if(mode == "login") localStorage.removeItem("bling.token");
    else localStorage.setItem("bling.token", JSON.stringify({
        user: "test@example.com", access_token: "test-token", refresh_token: "test-refresh",
        hardware_id: "00000000-0000-0000-0000-000000000000", tier: "u000", account_id: 1,
        expires_at: Date.now() + 3600 * 1000
    }));

    $.ajax = function(opts)
    {
        var url = opts.url;
        report.requests.push((opts.type || "GET") + " " + url.replace(/^https:\/\/rest-u000\.immedia-semi\.com/, ""));
        var method = (opts.type || "GET").toUpperCase();
        var reply = {status: 404, body: {message: "No fake for " + method + " " + url}};
        for(var i = 0; i < routes.length; i++)
        {
            var route = typeof routes[i][0] == "string" ? routes[i] : [null].concat(routes[i]);  // [method?, regex, reply]
            if(route[0] && route[0] != method) continue;
            var m = url.match(route[1]);
            if(m)
            {
                var r = typeof route[2] == "function" ? route[2](m) : route[2];
                reply = (r && r.status && !(r instanceof Blob)) ? r : {status: 200, body: r};
                break;
            }
        }
        var xhr = {status: reply.status, responseJSON: reply.status == 200 ? undefined : reply.body, setRequestHeader: function() {}};
        if(opts.beforeSend) opts.beforeSend(xhr);
        setTimeout(function()
        {
            if(reply.status == 200) { if(opts.success) opts.success(reply.body); }
            else if(opts.error) opts.error(xhr, "error", "Fake " + reply.status);
        }, 10);
        return {abort: function() {}};
    };

    function waitFor(cond, then, tries)
    {
        tries = tries === undefined ? 400 : tries;
        if(cond()) then();
        else if(tries > 0) setTimeout(function() { waitFor(cond, then, tries - 1); }, 50);
        else { report.errors.push("timed out waiting"); finish(); }
    }

    // WCAG contrast ratio between two CSS colours (text alpha blended over the background).
    function contrast(fg, bg)
    {
        var p = function(c) { return (c.match(/[\d.]+/g) || []).map(Number); };
        var f = p(fg), b = p(bg), a = f.length > 3 ? f[3] : 1;
        f = [0, 1, 2].map(function(i) { return f[i] * a + b[i] * (1 - a); });
        var lum = function(c)
        {
            c = c.map(function(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
            return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        };
        var l1 = lum(f), l2 = lum(b);
        return Math.round((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) * 100) / 100;
    }

    function finish()
    {
        report.items = $("ul.activity li").length;
        report.clips = $("ul.activity li").map(function() { return $(this).attr("title"); }).get();
        report.localTiles = $("ul.activity .videoThumbnail.local").length;
        report.selected = $("ul.activity li.selected").attr("title") || null;
        report.videoSrc = ($(".videoContainer video").attr("src") || "").replace(/^(blob|data):.*/, "$1:...");
        report.tableText = $.trim($(".tableContainer").text());
        report.videoText = $.trim($(".videoContainer").text());
        var empty = $(".content p.empty");
        if(empty.length)
        {
            // Visible = text colour differs from the nearest non-transparent background.
            var bg = "rgba(0, 0, 0, 0)", el = empty[0];
            while(el && /rgba\(0, 0, 0, 0\)|transparent/.test(bg)) { bg = getComputedStyle(el).backgroundColor; el = el.parentElement; }
            if(/rgba\(0, 0, 0, 0\)|transparent/.test(bg)) bg = "rgb(255, 255, 255)";  // nothing painted: the page's default white
            report.emptyColor = getComputedStyle(empty[0]).color;
            report.emptyBackground = bg;
            report.emptyContrast = contrast(report.emptyColor, bg);
        }
        report.contentText = $.trim($(".content").text()).slice(0, 300);
        report.userValue = $("#userInput").val();
        report.userLabelFloats = $("#userInput").closest(".mdl-textfield").hasClass("is-dirty");
        report.focused = document.activeElement && document.activeElement.id;
        report.loginOpen = $("#login").prop("open");
        report.signoutShown = $("#signout").css("display") != "none";
        report.rememberHidden = $("#login .remember").closest("label")[0].style.display == "none";
        report.rememberLabel = $("#login .remember").closest("label").find(".mdl-checkbox__label").text();
        var pre = document.createElement("pre");
        pre.id = "test-result";
        pre.textContent = JSON.stringify(report);
        document.body.appendChild(pre);
    }

    $(function()
    {
        if(mode == "login")
        {
            // Done when the email is filled in, or (public, nothing saved here) remember is relabelled.
            waitFor(function() { return $("#userInput").val() || /browser/.test($("#login .remember").closest("label").text()); },
                    function() { setTimeout(finish, 300); }, 60);
            return;
        }
        if(action == "cameras")
        {
            waitFor(function() { return $(".demo-card-square").length >= 2 && $("#camera_slider")[0].MaterialSlider; }, function()
            {
                setTimeout(function()
                {
                    var grid = $("#networkContainer .cameraContainer");
                    report.gridWidth = grid.width();
                    report.cards = $(".demo-card-square").map(function()
                    {
                        var r = this.getBoundingClientRect();
                        return {left: Math.round(r.left - grid.offset().left - parseFloat(grid.css("padding-left"))), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height)};
                    }).get();
                    report.sliderValue = Number($("#camera_slider").val());
                    var cardWidth = function() { return Math.round($(".demo-card-square")[0].getBoundingClientRect().width); };
                    $("#camera_slider").val(420).change();
                    report.widthAfterSlider = cardWidth();
                    $(window).trigger("resize");
                    setTimeout(function()
                    {
                        report.widthAfterResize = cardWidth();
                        var slider = $("#camera_slider");
                        report.sliderMax = Number(slider.attr("max"));
                        slider.val(slider.attr("max")).change();
                        report.widthAtSliderEnd = cardWidth();
                        report.gridWidthAtSliderEnd = $("#networkContainer .cameraContainer").width();
                        // Narrow the content as a smaller window would.
                        $(".layout > .content").css("width", "400px");
                        setTimeout(function()
                        {
                            report.widthNarrowed = cardWidth();
                            report.gridWidthNarrowed = $("#networkContainer .cameraContainer").width();
                            finish();
                        }, 300);
                    }, 300);
                }, 500);
            });
            return;
        }
        waitFor(function() { return $(".drawer .navigation a[title=Activity]").length && $("#toast")[0].MaterialSnackbar; }, function()
        {
            var snackbar = $("#toast")[0].MaterialSnackbar;
            snackbar.showSnackbar = function(d) { report.toasts.push(d.message); };
            $(".drawer .navigation a[title=Activity]").click();
            // Done when loading has finished and a clip is playing, a message is shown, or an error was toasted.
            waitFor(function()
            {
                var text = $(".videoContainer").text();
                return text.indexOf("Loading clips") < 0 && text.indexOf("Fetching clip") < 0 &&
                       ($(".videoContainer video").length || $(".content p.empty").length || report.toasts.length);
            }, function()
            {
                if(action == "signout")
                {
                    if(!$("#signout").is(":visible")) { report.errors.push("Sign out not shown"); finish(); return; }
                    sessionStorage.setItem("bling.test.signedOut", "1");
                    $("#signout").click();  // reloads the page
                    return;
                }
                if(action == "locations")
                {
                    report.tabs = $(".activityPage .tabs li").map(function() { return $(this).text(); }).get();
                    var shown = function() { return $("ul.activity li").not(".filtered").map(function() { return $(this).attr("title").split(" – ")[0]; }).get(); };
                    report.locations = {};
                    var tabs = $(".activityPage .tabs li");
                    var next = function(i)
                    {
                        if(i >= tabs.length) { finish(); return; }
                        tabs.eq(i).click();
                        setTimeout(function()
                        {
                            report.locations[tabs.eq(i).text()] = {
                                clips: shown(), selected: $("ul.activity li.selected").not(".filtered").attr("title") || null,
                                message: $.trim($(".content p.empty").text())};
                            next(i + 1);
                        }, 300);
                    };
                    setTimeout(function() { next(1); }, 300);
                    return;
                }
                if(action != "download") { setTimeout(finish, 300); return; }
                report.requestsBeforeDownload = report.requests.length;
                var icons = $(".videoThumbnail.local .download");
                icons.each(function() { $(this).click(); });
                waitFor(function() { return report.downloads.length >= icons.length || report.toasts.length; },
                        function() { setTimeout(finish, 300); });
            });
        });
    });
})();
