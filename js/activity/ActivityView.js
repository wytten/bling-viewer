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
                
                var i = 1;
                
                self.loadVideos(i, function()
                {
                   $('ul.activity li:nth-child(1)').trigger( 'click');
                });
                
                $(".tableContainer").scroll(function()
                {
                    if(Math.round($(this)[0].scrollHeight - $(this).scrollTop()) === Math.round($(this).outerHeight()))
                    {
                        i++;
                        self.loadVideos(i, function(){});
                    }
                });
            },
            enumerable: false
        },
        loadVideos : {
            value: function(page, loaded)
            {
                self.presenter.getVideos(page, function(data)
                {
                    var events = [];

                    console.log("Activity page " + page + ":", data);

                    var media = $.grep(data.media || [], function(v) { return !v.deleted; });
                    if(page == 1 && media.length == 0)
                    {
                        // In the (white) video area: the clip column has a black background.
                        $(".videoContainer").html("<p class='empty'>No clips in Blink's cloud storage for this account" +
                            (data.media ? "" : " (unexpected response, see the browser console)") + ".</p>");
                    }

                    if(data.media != undefined)
                    {
                        var ul = $("ul.activity");
                       
                        $.each( data.media, function( key, value )
                        {
                            if(!value.deleted)
                            {
                                var icon = "";
                                
                                var name = value.device_name || value.camera_name;  // newer API: device_name

                                for(var i = 0; i < self.cameras.length; ++i)
                                {
                                    if(self.cameras[i].name == name)
                                    {
                                        icon = "<img class='icon' src=\"img/" + self.cameras[i].type + ".png\"/>";
                                        break;
                                    }
                                }
                                var cameraName = icon + name;
                                
                                var li = $("<li/>", {"data-path" : value.media, html: '<div class="thumbnail"><div class="loadingContainer"><div class="mdl-spinner mdl-spinner--single-color mdl-js-spinner is-active"></div></div></div>'});
                                li.appendTo(ul);
                                
                                var time = $("<div/>", {html: moment(value.created_at).fromNow(), class: "timeVideo"});
                                
                                
                                self.presenter.getMedia(value.thumbnail + "_s.jpg", function(content)
                                {
                                    var container = li.find(".thumbnail");
                                    
                                    container.html("");
                                    
                                    var thumbnail = $("<div/>", {class: "videoThumbnail"});
                                    thumbnail.css("background-image", "url('data:image/png;base64," + content + "')");
                                    
                                    thumbnail.appendTo(container);
                                    
                                    time.prependTo(thumbnail);
                                });
                                
                                li.on('click', function ()
                                {
                                    $(this).addClass('selected').siblings().removeClass('selected');
                                    
                                    $(".videoContainer").html("<div class=\"mdl-progress mdl-js-progress mdl-progress__indeterminate\"></div>");
                                    
                                    componentHandler.upgradeAllRegistered();
                                    
                                    var path = $(this).data("path");
                                    
                                    self.presenter.getMedia(path, function(content)
                                    {
                                        $(".videoContainer").html("<video controls autoplay><source type='video/mp4' src='data:video/mp4;base64," + content + "'></video>");
                                    });
                                });
                            }
                        });
                        
                        componentHandler.upgradeAllRegistered();
                        
                        loaded();
                    }
                });
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
