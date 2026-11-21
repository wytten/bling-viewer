// Fake Blink backend for tests/activity_harness.html. Loaded right after jQuery and
// before the app's scripts: seeds a saved login, answers $.ajax with canned Blink
// responses, opens the Activity pane and reports what it drew in #test-result.
(function()
{
    var fixtureName = new URLSearchParams(location.search).get("fixture") || "empty";
    var report = {fixture: fixtureName, requests: [], toasts: [], errors: []};

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

    var fixtures = {
        empty: {media: []},  // with the defaults below, exactly what Blink returned for an account without cloud clips
        clips: {media: [clip(101, 5, "Front door"), clip(102, 60, "Front door"), clip(103, 120, "Laundry")]},
        deleted: {media: [$.extend(clip(104, 5, "Front door"), {deleted: true})]},
        nomedia: {message: "unexpected"},
        error500: null
    };
    var mediaPage1 = fixtures[fixtureName];

    var routes = [
        [/\/user$/, {email: "test@example.com", temp_units: "f"}],
        [/\/api\/v1\/camera\/usage$/, {networks: [{network_id: 1, name: "Home",
            cameras: [{id: 10, name: "Front door"}, {id: 11, name: "Laundry"}]}]}],
        [/\/api\/v3\/accounts\/1\/homescreen$/, {cameras: [{id: 10, type: "catalina", serial: "A1"},
            {id: 11, type: "catalina", serial: "A2"}], owls: [], doorbells: []}],
        [/\/network\/1\/camera\/(\d+)$/, function(m) { return {camera_status: {camera_id: +m[1], network_id: 1,
            thumbnail: "1700000000", temperature: 60, battery_state: "ok", updated_at: new Date().toISOString()}}; }],
        [/\/network\/1$/, {network: {id: 1, name: "Home"}, devicestatus: [{id: 10, name: "Front door", type: "white"}]}],
        [/\/media\/changed\?.*page=(\d+)$/, function(m)
        {
            if(m[1] != "1") return {media: []};
            if(mediaPage1 === null) return {status: 500, body: {message: "Internal Server Error"}};
            return $.extend({limit: 200, purge_id: 15952242263, refresh_count: 0}, mediaPage1);
        }],
        [/\/(thumbnail|thumb)\b/, ""],
        [/\/media\/clip\//, ""]
    ];

    localStorage.setItem("bling.token", JSON.stringify({
        user: "test@example.com", access_token: "test-token", refresh_token: "test-refresh",
        hardware_id: "00000000-0000-0000-0000-000000000000", tier: "u000", account_id: 1,
        expires_at: Date.now() + 3600 * 1000
    }));

    $.ajax = function(opts)
    {
        var url = opts.url;
        report.requests.push((opts.type || "GET") + " " + url.replace(/^https:\/\/rest-u000\.immedia-semi\.com/, ""));
        var reply = {status: 404, body: {message: "No fake for " + url}};
        for(var i = 0; i < routes.length; i++)
        {
            var m = url.match(routes[i][0]);
            if(m)
            {
                var r = typeof routes[i][1] == "function" ? routes[i][1](m) : routes[i][1];
                reply = (r && r.status) ? r : {status: 200, body: r};
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
        tries = tries === undefined ? 100 : tries;
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
        var pre = document.createElement("pre");
        pre.id = "test-result";
        pre.textContent = JSON.stringify(report);
        document.body.appendChild(pre);
    }

    $(function()
    {
        waitFor(function() { return $(".drawer .navigation a[title=Activity]").length && $("#toast")[0].MaterialSnackbar; }, function()
        {
            var snackbar = $("#toast")[0].MaterialSnackbar;
            snackbar.showSnackbar = function(d) { report.toasts.push(d.message); };
            $(".drawer .navigation a[title=Activity]").click();
            setTimeout(finish, 1500);
        });
    });
})();
