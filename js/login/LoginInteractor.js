(function(interactors)
{
    function LoginInteractor()
    {
        
    }

    Object.defineProperties(LoginInteractor.prototype,
    {
        // Blink's OAuth login runs inside bling-proxy.py (see /auth/* there).
        authPost : {
            value: function(path, body, listener)
            {
				$.ajax
				({
					type: "POST",
					url: path,
					data: JSON.stringify(body),
					contentType: 'application/json',
					dataType: 'json',
					success: function (json)
					{
						listener.onSuccess(json);
					},
					error: function (jqxhr, textStatus, error)
					{
						var data = jqxhr.responseJSON || {message: "Login service unavailable (" + jqxhr.status + "); is bling-proxy.py running?"};
						data.status = jqxhr.status;
						listener.onError(data);
					}
				});
            },
            enumerable: false
        },
        login : {
            value: function(user, password, hardware_id, listener)
            {
				this.authPost("auth/login", {email: user, password: password, hardware_id: hardware_id}, listener);
            },
            enumerable: false
        },
		verify : {
            value: function(session, pin, remember, listener)
            {
				this.authPost("auth/verify", {session: session, pin: pin, remember: !!remember}, listener);
            },
            enumerable: false
        },
		refresh : {
            value: function(refresh_token, hardware_id, listener)
            {
				this.authPost("auth/refresh", {refresh_token: refresh_token, hardware_id: hardware_id}, listener);
            },
            enumerable: false
        },
        getLastLogin : {
            value: function(onSuccess)
            {
				$.ajax({type: "GET", url: "auth/last-login", dataType: 'json', success: onSuccess});  // optional; ignore errors
            },
            enumerable: false
        },
        // The last email that signed in, kept in this browser (apart from the session, so
        // signing out or an expired session doesn't lose it).
        setLastUser : {
            value: function(user)
            {
				if(user) localStorage.setItem("bling.lastUser", user);
            },
            enumerable: false
        },
        getLastUser : {
            value: function()
            {
				return localStorage.getItem("bling.lastUser");
            },
            enumerable: false
        },
        setToken : {
            value: function(data)
            {
				if(data)
				{
					localStorage.setItem("bling.token", JSON.stringify(data));
				}
				else
				{
					localStorage.removeItem("bling.token");
				}
            },
            enumerable: false
        },
        getToken : {
            value: function()
            {
				try
				{
					return JSON.parse(localStorage.getItem("bling.token")) || null;
				}
				catch(e)
				{
					return null;
				}
            },
            enumerable: false
        },
        getUser : {
            value: function(listener)
            {
				$.ajax
				({
					type: "GET",
					url: "https://rest-" + credentials.region + "." + server + "/user",
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
        }
    });

    interactors.LoginInteractor = LoginInteractor;
})(blink.interactors);
