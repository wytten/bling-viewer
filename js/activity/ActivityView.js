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
            value: function(data)
            {
                this.initTable(data);
            },
            enumerable: false
        },
        initTable : {
            value: function(cameras)
            {
                $(".content").html("<div class='tableContainer'><ul class='activity display' width='100%'></ul></div>" +
                                    "<div class='videoContainer'></div>");
                
                this.cameras = cameras;
                this.clipCount = 0;
                var sources = 2;  // cloud page 1 and Sync Module local storage
                var page = 1;
                var cloudMore = true;

                // In the (white) video area: the clip column has a black background.
                $(".videoContainer").html("<p class='empty'>Loading clips…</p>");

                var sourceDone = function()
                {
                    if(--sources > 0) return;
                    if(self.clipCount == 0)
                    {
                        $(".videoContainer").html("<p class='empty'>No clips found in Blink's cloud storage or on a Sync Module.</p>");
                    }
                    else if(!$("ul.activity li.selected").length)
                    {
                        $("ul.activity li").first().trigger("click");
                    }
                };

                self.loadVideos(page, function(more) { cloudMore = more; sourceDone(); });

                self.presenter.getLocalClips(function(clips)
                {
                    $.each(clips, function(i, clip) { self.addClip(clip); });
                }, sourceDone);
                
                $(".tableContainer").scroll(function()
                {
                    if(cloudMore && Math.round($(this)[0].scrollHeight - $(this).scrollTop()) === Math.round($(this).outerHeight()))
                    {
                        page++;
                        self.loadVideos(page, function(more) { cloudMore = more; });
                    }
                });
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
                var li = $("<li/>", {"data-time": time.valueOf(), title: (clip.name || "") + " – " + time.format("lll") +
                                     (clip.local ? " (Sync Module local storage)" : ""),
                                     html: '<div class="thumbnail"><div class="loadingContainer"><div class="mdl-spinner mdl-spinner--single-color mdl-js-spinner is-active"></div></div></div>'});

                var later = $("ul.activity li").filter(function() { return +$(this).attr("data-time") < time.valueOf(); }).first();
                if(later.length) li.insertBefore(later); else li.appendTo($("ul.activity"));

                var label = $("<div/>", {class: "timeVideo", html: time.fromNow() + (clip.name ? "<br>" + $("<span/>").text(clip.name).html() : "")});
                var showThumbnail = function(css)
                {
                    var container = li.find(".thumbnail");
                    container.html("");
                    var thumbnail = $("<div/>", {class: "videoThumbnail" + (clip.local ? " local" : "")});
                    if(css) thumbnail.css("background-image", css);
                    else thumbnail.html("<i class='fas fa-hdd' title='Sync Module local storage'></i>");
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
