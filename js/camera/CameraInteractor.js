(function(interactors)
{
    function CameraInteractor()
    {
        
    }

    Object.defineProperties(CameraInteractor.prototype,
    {
        getCamera : {
            value: function(networkId, cameraId, listener)
            {
				$.ajax
				({
					type: "GET",
					url: "https://rest-" + credentials.region + "." + server + "/network/" + networkId + "/camera/" + cameraId,
                    dataType: 'json',
					beforeSend: function(xhr) {                        
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function (data)
					{
						listener.onSuccess(data);
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError(jqxhr.responseJSON);
					}
				});
            },
            enumerable: false
        },
        // Blink's "thumbnail" field comes in three shapes (same handling as blinkpy):
        //   "/api/v3/media/...thumbnail.jpg?ts=...&ext="  current full path, use as is
        //   "1700000000"                                   just a timestamp, build the v3 path
        //   "/media/production/.../thumbnail"              legacy, append ".jpg"
        thumbnailPath : {
            value: function(camera, info)
            {
				var thumb = String(camera.thumbnail || "");
				if(/^\d+$/.test(thumb))
				{
					return "/api/v3/media/accounts/" + credentials.account.id + "/networks/" + camera.network_id +
						"/" + (camera.type || (info[camera.camera_id] || {}).type || "catalina") + "/" + camera.camera_id + "/thumbnail/thumbnail.jpg?ts=" + thumb + "&ext=";
				}
				if(/&ext=$/.test(thumb) || /\.jpg(\?|$)/.test(thumb))
				{
					return thumb;
				}
				return thumb + ".jpg";
            },
            enumerable: false
        },
        getThumbnail : {
            value: function(camera, listener)
            {
				var self = this;
				// A bare-timestamp thumbnail needs the camera's product type, which only the homescreen has.
				cameraInfo.done(function(info)
				{
					var path = self.thumbnailPath(camera, info);
					var url = /^https?:/.test(path) ? path : "https://rest-" + credentials.region + "." + server + path;
					$.ajax
					({
						type: "GET",
						url: url,
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
							listener.onError(jqxhr.responseJSON);
						}
					});
				});
            },
            enumerable: false
        },
        requestThumbnail : {
            value: function(network, camera, listener)
            {
				$.ajax
				({
					type: "POST",
					url: "https://rest-" + credentials.region + "." + server + "/network/" + network + "/camera/" + camera + "/thumbnail",
                    dataType: 'json',
					beforeSend: function(xhr) {                        
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function (data)
					{
						listener.onSuccess(data);
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError(jqxhr.responseJSON);
					}
				});
            },
            enumerable: false
        },
        requestLiveView : {
            value: function(network, camera, listener)
            {
				cameraInfo.done(function(info)
				{
					var type = (info[camera] || {}).type;
					var base = "https://rest-" + credentials.region + "." + server;
					var path = /^(owl|hawk)$/.test(type) ? "/api/v2/accounts/" + credentials.account.id + "/networks/" + network + "/owls/" + camera + "/liveview"
						: type == "lotus" ? "/api/v2/accounts/" + credentials.account.id + "/networks/" + network + "/doorbells/" + camera + "/liveview"
						: "/api/v6/accounts/" + credentials.account.id + "/networks/" + network + "/cameras/" + camera + "/liveview";
					$.ajax
					({
						type: "POST",
						url: base + path,
						data: JSON.stringify({intent: "liveview", motion_event_start_time: null}),
						contentType: 'application/json',
						dataType: 'json',
						beforeSend: function(xhr) {
							xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
						},
						success: function (data)
						{
							data.network_id = network;
							listener.onSuccess(data);
						},
						error: function (jqxhr, textStatus, error)
						{
							listener.onError(jqxhr.responseJSON || {message: "Live view request failed (" + jqxhr.status + ")"});
						}
					});
				});
            },
            enumerable: false
        },
        checkCommand : {
            value: function(network, command, listener)
            {
				$.ajax
				({
					type: "GET",
					url: "https://rest-" + credentials.region + "." + server + "/network/" + network + "/command/" + command,
                    dataType: 'json',
					beforeSend: function(xhr) {                        
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function (data)
					{
						listener.onSuccess(data);
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError(jqxhr.responseJSON);
					}
				});
            },
            enumerable: false
        },
        joinCommand : {
            value: function(network, camera, command, listener)
            {
				$.ajax
				({
					type: "GET",
					url: "https://rest-" + credentials.region + "." + server + "/api/v5/accounts/" + credentials.account.id + "/networks/" + network + "/cameras/" + camera + "/join/" + command,
                    dataType: 'json',
					beforeSend: function(xhr) {                        
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function (data)
					{
						listener.onSuccess(data);
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError(jqxhr.responseJSON);
					}
				});
            },
            enumerable: false
        },
        updateCommand : {
            value: function(network, command, listener)
            {
				$.ajax
				({
					type: "POST",
					url: "https://rest-" + credentials.region + "." + server + "/network/" + network + "/update",
                    dataType: 'json',
					beforeSend: function(xhr) {                        
						xhr.setRequestHeader("Authorization", "Bearer " + credentials.token);
					},
					success: function (data)
					{
						listener.onSuccess(data);
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError(jqxhr.responseJSON);
					}
				});
            },
            enumerable: false
        },
        // bling-proxy.py turns Blink's immis stream into HLS (this used to be Bling Desktop on :9192).
        requestJoin : {
            value: function(camera, live, listener)
            {
				cameraInfo.done(function(info)
				{
					$.ajax
					({
						type: "POST",
						url: "live/start",
						data: JSON.stringify({
							camera_id: camera, network_id: live.network_id, serial: (info[camera] || {}).serial,
							server: live.server, command_id: live.command_id, polling_interval: live.polling_interval,
							token: credentials.token, region: credentials.region
						}),
						dataType: 'json',
						contentType: 'application/json',
						success: function (data)
						{
							listener.onSuccess(data);
						},
						error: function (jqxhr, textStatus, error)
						{
							listener.onError(jqxhr.responseJSON || {message: "Live view failed (" + jqxhr.status + "); restart bling-proxy.py"});
						}
					});
				});
            },
            enumerable: false
        },
        requestUnjoin : {
            value: function(camera, listener)
            {
				$.ajax
				({
					type: "POST",
					url: "live/stop",
					data: JSON.stringify({camera_id: camera}),
					dataType: 'json',
					contentType: 'application/json',
					success: function (data)
					{
						listener.onSuccess(data);
					},
					error: function (jqxhr, textStatus, error)
					{
						listener.onError(jqxhr.responseJSON || {message: "Stopping live view failed (" + jqxhr.status + ")"});
					}
				});
            },
            enumerable: false
        }
    });

    interactors.CameraInteractor = CameraInteractor;
})(blink.interactors);
