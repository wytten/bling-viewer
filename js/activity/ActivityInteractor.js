(function(interactors)
{
    function ActivityInteractor()
    {
        
    }

    Object.defineProperties(ActivityInteractor.prototype,
    {
        getVideos : {
            value: function(page, listener)
            {
				return $.ajax
				({
					type: "GET",
					url: "https://rest-" + credentials.region + "." + server + "/api/v1/accounts/" + credentials.account.id + "/media/changed?since=1970-01-01T00:00:00+0000&page=" + page,
					dataType: 'json',
					beforeSend: function(xhr) { 
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function (json)
					{
						listener.onSuccess(json);
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError({message: "Activity request failed (" + jqxhr.status + (error ? " " + error : "") + ")"});
					}
				});
            },
            enumerable: false
        },
        getVideosCount : {
            value: function(listener)
            {
				return $.ajax
				({
					type: "GET",
					url: "https://rest-" + credentials.region + "." + server + "/api/v2/videos/count",
					dataType: 'json',
					beforeSend: function(xhr) { 
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function (json)
					{
						listener.onSuccess(json);
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError({message: "Activity request failed (" + jqxhr.status + (error ? " " + error : "") + ")"});
					}
				});
            },
            enumerable: false
        },
        getMedia : {
            value: function(path, listener)
            {
				$.ajax
				({
					type: "GET",
					url: "https://rest-" + credentials.region + "." + server + path,
                    mimeType: "text/plain; charset=x-user-defined",
					beforeSend: function(xhr) {                        
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function (data)
					{
						listener.onSuccess(base64Encode(data));
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError({message: "Activity request failed (" + jqxhr.status + (error ? " " + error : "") + ")"});
					}
				});
            },
            enumerable: false
        },
        downloadMedia : {
            value: function(path, listener)
            {
				$.ajax
				({
					type: "GET",
					url: "https://rest-" + credentials.region + "." + server + path,
					beforeSend: function(xhr) {                        
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
                    xhrFields: {
                        responseType: 'blob'
                    },
					success: function (data)
					{
						listener.onSuccess(data);
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError({message: "Activity request failed (" + jqxhr.status + (error ? " " + error : "") + ")"});
					}
				});
            },
            enumerable: false
        },
        // --- Sync Module local storage (same calls as blinkpy) ---
        blink : {
            value: function(type, path, binary, onSuccess, onError)
            {
				$.ajax
				({
					type: type,
					url: "https://rest-" + credentials.region + "." + server + path,
					dataType: binary ? undefined : 'json',
					xhrFields: binary ? {responseType: 'blob'} : undefined,
					beforeSend: function(xhr) {
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function (data) { onSuccess(data); },
					error: function (jqxhr, textStatus, error)
					{
						onError({message: "Sync Module request failed (" + jqxhr.status + (error ? " " + error : "") + ")"});
					}
				});
            },
            enumerable: false
        },
        // A POST that changes something (body: JSON, or none); the reply isn't needed.
        post : {
            value: function(path, body, onSuccess, onError)
            {
				$.ajax
				({
					type: "POST",
					url: "https://rest-" + credentials.region + "." + server + path,
					data: body === undefined ? undefined : JSON.stringify(body),
					contentType: body === undefined ? undefined : "application/json",
					dataType: "text",
					beforeSend: function(xhr) {
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function () { onSuccess(); },
					error: function (jqxhr, textStatus, error)
					{
						onError({message: "Delete failed (" + jqxhr.status + (error ? " " + error : "") + ")"});
					}
				});
            },
            enumerable: false
        },
        // Cloud clips, by their media ids (BlinkMonitorProtocol: POST .../media/delete).
        deleteCloudMedia : {
            value: function(ids, onSuccess, onError)
            {
				this.post("/api/v1/accounts/" + credentials.account.id + "/media/delete", {media_list: ids}, onSuccess, onError);
            },
            enumerable: false
        },
        // A clip on Sync Module local storage (blinkpy's delete_video: the clip URL, "request" -> "delete").
        deleteLocalClip : {
            value: function(network, sync, manifest, clip, onSuccess, onError)
            {
				this.post(this.localStoragePath(network, sync) + "/manifest/" + manifest + "/clip/delete/" + clip, undefined, onSuccess, onError);
            },
            enumerable: false
        },
        localStoragePath : {
            value: function(network, sync)
            {
				return "/api/v1/accounts/" + credentials.account.id + "/networks/" + network + "/sync_modules/" + sync + "/local_storage";
            },
            enumerable: false
        },
        // Poll a Blink command until it completes (status_code 908 = still valid).
        waitCommand : {
            value: function(network, command, onDone, onError, tries)
            {
				var self = this;
				tries = tries === undefined ? 60 : tries;
				this.blink("GET", "/network/" + network + "/command/" + command, false, function(status)
				{
					if(status.status_code && status.status_code != 908) onError({message: "Sync Module command failed (" + status.status_code + ")"});
					else if(status.complete) onDone();
					else if(tries <= 0) onError({message: "Sync Module didn't respond in time"});
					else setTimeout(function() { self.waitCommand(network, command, onDone, onError, tries - 1); }, 1000);
				}, onError);
            },
            enumerable: false
        },
        // Ask the Sync Module to list its clips, wait, then fetch the list (retrying while it's busy).
        getLocalManifest : {
            value: function(network, sync, onSuccess, onError)
            {
				var self = this, base = this.localStoragePath(network, sync);
				this.blink("POST", base + "/manifest/request", false, function(req)
				{
					var fetch = function(retry)
					{
						self.blink("GET", base + "/manifest/request/" + req.id, false, function(manifest)
						{
							if(manifest && manifest.clips) onSuccess(manifest);
							else if(retry >= 3) onError({message: "Sync Module didn't return its clip list"});
							else setTimeout(function() { fetch(retry + 1); }, 3000 * Math.pow(2, retry));
						}, onError);
					};
					self.waitCommand(req.network_id || network, req.id, function() { fetch(0); }, onError);
				}, onError);
            },
            enumerable: false
        },
        // Have the Sync Module upload one clip, wait, then download it as a Blob.
        getLocalClip : {
            value: function(network, sync, manifest, clip, onSuccess, onError)
            {
				var self = this, path = this.localStoragePath(network, sync) + "/manifest/" + manifest + "/clip/request/" + clip;
				this.blink("POST", path, false, function(req)
				{
					self.waitCommand(req.network_id || network, req.id, function()
					{
						self.blink("GET", path, true, onSuccess, onError);
					}, onError);
				}, onError);
            },
            enumerable: false
        }
    });

    interactors.ActivityInteractor = ActivityInteractor;
})(blink.interactors);
