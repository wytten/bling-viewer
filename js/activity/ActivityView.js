(function(views)
{
    var self;
    var timeline;

    function ActivityView(presenter)
    {
        self = this;
        this.presenter = presenter;
    }

    Object.defineProperties(ActivityView.prototype,
    {
        init : {
            value: function()
            {

            },
            enumerable: false
        },
        onLogin : {
            value: function()
            {
                var activity = $("<a/>", {class: "link", href: "#", title: "Activity", html: "<i class='fas fa-running'></i>"});
                
                activity.click(function(evt)
                {
                    $(this).addClass("selected").siblings().removeClass("selected");
                    
                    self.presenter.getCameras();
                    evt.preventDefault();
                });
                
                activity.appendTo($(".drawer .navigation"));
            },
            enumerable: false
        },
        onCameras : {
            value: function(data, networks)
            {
                this.initTable(data, networks || []);
            },
            enumerable: false
        },
        initTable : {
            value: function(cameras, networks)
            {
                $(".content").html("<div class='activityPage'><ul class='tabs'></ul><div class='activityBody'>" +
                                    "<div class='clipColumn'><div class='clipTools'>" +
                                    "<label title='Select every clip shown'><input type='checkbox' class='selectAll'/>All</label>" +
                                    "<button class='deleteClips' type='button' disabled title='Delete the selected clips'>" +
                                    "<i class='fas fa-trash-alt'></i> <span>Delete</span></button></div>" +
                                    "<div class='tableContainer'><ul class='activity display' width='100%'></ul></div></div>" +
                                    "<div class='videoContainer'></div></div></div>");
                
                this.cameras = cameras;
                this.clipCount = 0;
                this.network = null;  // the location (network_id) shown; null: all
                var sources = 2;  // cloud page 1 and Sync Module local storage
                var page = 1;
                var cloudMore = true;
                var loading = false;

                // In the (white) video area: the clip column has a black background.
                $(".videoContainer").html("<p class='empty'>Loading clips…</p>");

                // The locations, as on the cameras page: All, then one tab per network.
                var tabs = $(".activityPage .tabs");
                var tab = function(label, network)
                {
                    $("<li/>", {text: label, class: network === null ? "active" : ""}).click(function()
                    {
                        $(this).addClass("active").siblings().removeClass("active");
                        self.network = network;
                        $("ul.activity li").each(function() { $(this).toggleClass("filtered", !self.shows(this)); });
                        $("ul.activity li.filtered .pick").prop("checked", false);  // only delete what's shown
                        self.updateTools();
                        settle();
                    }).appendTo(tabs);
                };
                tab("All", null);
                $.each(networks, function(i, n) { tab(n.name, n.network_id); });

                var more = function()
                {
                    if(!cloudMore || loading) return;
                    loading = true;
                    page++;
                    self.loadVideos(page, function(m) { cloudMore = m; loading = false; settle(); });
                };

                // Once both sources have answered: keep a clip of the shown location selected,
                // and fetch more cloud clips while the list doesn't fill its column.
                var settle = function()
                {
                    if(sources > 0) return;
                    var shown = $("ul.activity li").not(".filtered");
                    var box = $(".tableContainer")[0];
                    if(box && box.scrollHeight <= box.clientHeight + 1) more();
                    if(!shown.length)
                    {
                        $("ul.activity li.selected").removeClass("selected");
                        var name = tabs.find("li.active").text();
                        $(".videoContainer").html($("<p class='empty'/>").text(
                            loading ? "Loading clips…" :
                            self.clipCount == 0 ? "No clips found in Blink's cloud storage or on a Sync Module." :
                            "No clips for " + name + "."));
                    }
                    else if(!shown.filter(".selected").length)
                    {
                        shown.first().trigger("click");
                    }
                };

                self.settle = settle;

                var sourceDone = function()
                {
                    --sources;
                    settle();
                };

                $(".clipTools .selectAll").change(function()
                {
                    $("ul.activity li").not(".filtered").find(".pick").prop("checked", this.checked);
                    self.updateTools();
                });
                $(".clipTools .deleteClips").click(function() { self.deletePicked(); });

                self.loadVideos(page, function(m) { cloudMore = m; sourceDone(); });

                self.presenter.getLocalClips(function(clips)
                {
                    $.each(clips, function(i, clip) { self.addClip(clip); });
                }, sourceDone);
                
                $(".tableContainer").scroll(function()
                {
                    if(Math.round($(this)[0].scrollHeight - $(this).scrollTop()) === Math.round($(this).outerHeight()))
                    {
                        more();
                    }
                });
            },
            enumerable: false
        },
        // The selected clips shown, and the Select all / Delete controls to match.
        picked : {
            value: function()
            {
                return $("ul.activity li").not(".filtered").filter(function() { return $(this).find(".pick").prop("checked"); });
            },
            enumerable: false
        },
        updateTools : {
            value: function()
            {
                var shown = $("ul.activity li").not(".filtered").length;
                var n = self.picked().length;
                var all = $(".clipTools .selectAll");
                all.prop("checked", n > 0 && n == shown).prop("indeterminate", n > 0 && n < shown);
                var button = $(".clipTools .deleteClips");
                if(button.hasClass("busy")) return;
                button.prop("disabled", n == 0).find("span").text(n ? "Delete (" + n + ")" : "Delete");
            },
            enumerable: false
        },
        deletePicked : {
            value: function()
            {
                var lis = self.picked();
                if(!lis.length) return;
                var where = lis.filter(function() { return $(this).data("clip").local; }).length ? " Clips on a Sync Module are deleted from it too." : "";
                if(!window.confirm("Delete " + lis.length + " clip" + (lis.length == 1 ? "" : "s") + "? This can't be undone." + where)) return;

                var button = $(".clipTools .deleteClips").addClass("busy").prop("disabled", true);
                button.find("span").text("Deleting…");
                var clips = lis.map(function() { return $(this).data("clip"); }).get();
                self.presenter.deleteClips(clips, function(clip)
                {
                    lis.filter(function() { return $(this).data("clip") === clip; }).remove();
                    self.clipCount--;
                },
                function(errors)
                {
                    button.removeClass("busy");
                    self.updateTools();
                    if(errors.length) self.showError({message: "Some clips weren't deleted: " + errors[0].message});
                    if(self.settle) self.settle();
                });
            },
            enumerable: false
        },
        // Whether a clip's <li> belongs to the location shown.
        shows : {
            value: function(li)
            {
                return self.network === null || +$(li).attr("data-network") === +self.network;
            },
            enumerable: false
        },
        // One page of cloud clips; done(moreAvailable).
        loadVideos : {
            value: function(page, done)
            {
                self.presenter.getVideos(page, function(data)
                {
                    console.log("Activity page " + page + ":", data);

                    if(!data.media)
                    {
                        self.showError({message: "Unexpected response for cloud clips (see the browser console)"});
                    }

                    var media = $.grep(data.media || [], function(v) { return !v.deleted; });
                    $.each(media, function(key, value)
                    {
                        self.addClip({
                            created_at: value.created_at,
                            name: value.device_name || value.camera_name,  // newer API: device_name
                            network_id: value.network_id,
                            cloudId: value.id,
                            thumbnail: value.thumbnail + "_s.jpg",
                            play: function(onUrl, onError)
                            {
                                self.presenter.getMedia(value.media, function(content)
                                {
                                    onUrl("data:video/mp4;base64," + content);
                                });
                            }
                        });
                    });

                    done((data.media || []).length > 0);
                },
                function() { done(false); });
            },
            enumerable: false
        },
        // Add a clip to the list, keeping it newest first.
        addClip : {
            value: function(clip)
            {
                self.clipCount++;

                var time = moment(clip.created_at);
                var li = $("<li/>", {"data-time": time.valueOf(), "data-network": clip.network_id, title: (clip.name || "") + " – " + time.format("lll") +
                                     (clip.local ? " (Sync Module local storage)" : ""),
                                     html: '<div class="thumbnail"><div class="loadingContainer"><div class="mdl-spinner mdl-spinner--single-color mdl-js-spinner is-active"></div></div></div>'});

                var later = $("ul.activity li").filter(function() { return +$(this).attr("data-time") < time.valueOf(); }).first();
                if(later.length) li.insertBefore(later); else li.appendTo($("ul.activity"));
                li.toggleClass("filtered", !self.shows(li));
                li.data("clip", clip);
                $("<input/>", {type: "checkbox", class: "pick", title: "Select"}).appendTo(li)
                    .click(function(evt) { evt.stopPropagation(); })  // don't also play it
                    .change(function() { self.updateTools(); });
                self.updateTools();

                var label = $("<div/>", {class: "timeVideo", html: time.fromNow() + (clip.name ? "<br>" + $("<span/>").text(clip.name).html() : "")});
                var showThumbnail = function(css)
                {
                    var container = li.find(".thumbnail");
                    container.html("");
                    var thumbnail = $("<div/>", {class: "videoThumbnail" + (clip.local ? " local" : "")});
                    if(css) thumbnail.css("background-image", css);
                    else thumbnail.html("<i class='fas fa-hdd' title='Sync Module local storage'></i>");
                    if(clip.local)
                    {
                        $("<i class='download fas fa-download' title='Download clip'></i>").appendTo(thumbnail).click(function(evt)
                        {
                            evt.stopPropagation();  // don't also play it
                            self.downloadClip(clip, $(this));
                        });
                    }
                    thumbnail.appendTo(container);
                    label.prependTo(thumbnail);
                };

                if(clip.thumbnail)
                {
                    self.presenter.getMedia(clip.thumbnail, function(content)
                    {
                        showThumbnail("url('data:image/png;base64," + content + "')");
                    });
                }
                else
                {
                    showThumbnail(null);  // local clips have no thumbnail
                }

                li.on('click', function ()
                {
                    $(this).addClass('selected').siblings().removeClass('selected');

                    $(".videoContainer").html("<div class=\"mdl-progress mdl-js-progress mdl-progress__indeterminate\"></div>" +
                        (clip.local ? "<p class='empty'>Fetching clip from the Sync Module…</p>" : ""));
                    componentHandler.upgradeAllRegistered();

                    clip.play(function(src)
                    {
                        if(!li.hasClass("selected")) return;  // another clip was picked meanwhile
                        $(".videoContainer").html($("<video controls autoplay/>").attr("src", src));
                    },
                    function(error)
                    {
                        $(".videoContainer").html("");
                        self.showError(error);
                    });
                });

                componentHandler.upgradeAllRegistered();
            },
            enumerable: false
        },
        renderThumbnail : {
            value: function(data, type, row, meta)
            {
                self.presenter.getMedia(data, function(content)
                {
                    var container = $("#thumbnail" + meta.row);
                    
                    container.html("");
                    
                    var thumbnail = $("<div/>", {class: "videoThumbnail"});
                    thumbnail.css("background-image", "url('data:image/png;base64," + content + "')");
                    
                    thumbnail.appendTo(container);
                });
                
                return '<div class="thumbnail" id="thumbnail' + meta.row + '"><div class="loadingContainer"><div class="mdl-spinner mdl-spinner--single-color mdl-js-spinner is-active"></div></div></div>';
            },
            enumerable: false
        },
        renderActions : {
            value: function(data, type, row, meta)
            {
                return '<div class="actions"><i class="download fas fa-download" title="Download video" data-path="' + data + '"></i></div>';
            },
            enumerable: false
        },
        // Save a clip as "<camera> <date time>.mp4".
        downloadClip : {
            value: function(clip, icon)
            {
                if(icon.hasClass("fa-spinner")) return;  // already fetching
                icon.removeClass("fa-download").addClass("fa-spinner fa-spin").attr("title", "Fetching clip from the Sync Module…");
                var restore = function() { icon.removeClass("fa-spinner fa-spin").addClass("fa-download").attr("title", "Download clip"); };

                clip.play(function(url)
                {
                    var name = ((clip.name || "Blink") + " " + moment(clip.created_at).format("YYYY-MM-DD HH.mm.ss"))
                        .replace(/[\\/:*?"<>|]+/g, "_") + ".mp4";
                    var a = $("<a/>", {href: url, download: name}).appendTo("body");
                    a[0].click();
                    a.remove();
                    restore();
                },
                function(error)
                {
                    restore();
                    self.showError(error);
                });
            },
            enumerable: false
        },
        showError : {
            value: function(data)
            {
                console.error(data);
                document.querySelector('#toast').MaterialSnackbar.showSnackbar({message: (data && data.message) || "Activity request failed"});
            },
            enumerable: false
        }
    });

    views.ActivityView = ActivityView;
})(blink.views);
