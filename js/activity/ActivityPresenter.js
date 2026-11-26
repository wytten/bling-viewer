(function(presenters)
{
    function ActivityPresenter(Context)
    {
        this.interactor = Context.getActivityInteractor();
        this.networkInteractor = Context.getNetworkInteractor();
       
        this.activityView = Context.getActivityView(this);
        this.activityView.init();
    }

    Object.defineProperties(ActivityPresenter.prototype,
    {
        getCameras : {
            value: function()
            {
                var self = this;
                
                var cameras = [];
                
                this.networkInteractor.getNetworks(new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
                        var networks = data.networks;
                        var numNetworks = data.networks.length;
                        var i = 0;
                        
                        $.each( data.networks, function( key, value )
                        {
                            self.networkInteractor.getNetwork(value.network_id, new blink.listeners.BaseDecisionListener(
                            function(data)
                            {
                                i++;
                                
                                $.each( data.devicestatus, function( key, value )
                                {
                                    cameras.push(value);
                                });
                                
                                if(i >= numNetworks)
                                {
                                    self.activityView.onCameras(cameras, networks);
                                }
                            },
                            function(data)
                            {
                                self.activityView.showError(data);
                            })); 
                        });
                    },
                    function(data)
                    {
                        self.activityView.showError(data);
                    }));
            },
            enumerable: false
        },
        getVideos : {
            value: function(page, callback, onError)
            {
                var self = this;
                
                return this.interactor.getVideos(page, new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
						if(data && data.media) data.media.sort((a, b) => moment(b.created_at).toDate() - moment(a.created_at).toDate());
                        callback(data);
                    },
                    function(data)
                    {
                        self.activityView.showError(data);
                        if(onError) onError(data);
                    }));
            },
            enumerable: false
        },
        // Clips on Sync Module local storage (USB). Calls onClips(list) per module, then onDone().
        // Each clip: {created_at, name, local: true, play(onUrl, onError)}.
        getLocalClips : {
            value: function(onClips, onDone)
            {
                var self = this;

                homescreenData.done(function(home)
                {
                    var modules = $.grep(home.sync_modules || [], function(m) { return m.local_storage_status == "active"; });
                    var pending = modules.length;
                    if(!pending) { onDone(); return; }

                    // The manifest names cameras without spaces/punctuation ("Frontdoor").
                    var names = {};
                    $.each([].concat(home.cameras || [], home.owls || [], home.doorbells || []), function(i, c)
                    {
                        if(c.name) names[c.name.replace(/[^A-Za-z0-9]/g, "")] = c.name;
                    });
                    var finished = function() { if(--pending == 0) onDone(); };

                    $.each(modules, function(i, m)
                    {
                        self.interactor.getLocalManifest(m.network_id, m.id, function(manifest)
                        {
                            onClips($.map(manifest.clips, function(c)
                            {
                                // Fetch once (the module uploads the clip each time it's requested);
                                // play and download share the result.
                                var url = null, waiting = null;
                                return {
                                    created_at: c.created_at,
                                    name: names[c.camera_name] || c.camera_name,
                                    network_id: m.network_id,
                                    local: true,
                                    play: function(onUrl, onError)
                                    {
                                        if(url) { onUrl(url); return; }
                                        if(waiting) { waiting.push([onUrl, onError]); return; }
                                        waiting = [[onUrl, onError]];
                                        self.interactor.getLocalClip(m.network_id, m.id, manifest.manifest_id, c.id,
                                            function(blob)
                                            {
                                                url = URL.createObjectURL(blob);
                                                var w = waiting; waiting = null;
                                                $.each(w, function(i, cb) { cb[0](url); });
                                            },
                                            function(error)
                                            {
                                                var w = waiting; waiting = null;
                                                $.each(w, function(i, cb) { cb[1](error); });
                                            });
                                    }
                                };
                            }));
                            finished();
                        },
                        function(error)
                        {
                            self.activityView.showError(error);
                            finished();
                        });
                    });
                });
            },
            enumerable: false
        },
        getVideosCount : {
            value: function(callback)
            {
                var self = this;
                
                return this.interactor.getVideosCount(new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
                        callback(data);
                    },
                    function(data)
                    {
                        self.activityView.showError(data);
                    }));
            },
            enumerable: false
        },
        getMedia : {
            value: function(path, callback)
            {
                var self = this;
                    
                this.interactor.getMedia(path, new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
                        callback(data);
                    },
                    function(data)
                    {
                        self.activityView.showError(data);
                    }));
            },
            enumerable: false
        },
        downloadMedia : {
            value: function(path, callback)
            {
                var self = this;
                    
                this.interactor.downloadMedia(path, new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
                        callback(data);
                    },
                    function(data)
                    {
                        self.activityView.showError(data);
                    }));
            },
            enumerable: false
        }
    });

    presenters.ActivityPresenter = ActivityPresenter;
})(blink.presenters);
