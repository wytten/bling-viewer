(function(presenters)
{
    function LoginPresenter(Context)
    {
        this.interactor = Context.getLoginInteractor();
       
        this.loginView = Context.getLoginView(this);
        this.loginView.init();

        this.homescreenView = Context.getHomescreenPresenter().view;
        this.networkView = Context.getNetworkPresenter().networkView;
        this.activityView = Context.getActivityPresenter().activityView;
    }

    Object.defineProperties(LoginPresenter.prototype,
    {
        login : {
            value: function(user, password)
            {
                var self = this;
                var stored = this.interactor.getToken();

                this.interactor.login(user, password, stored && stored.hardware_id, new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
						if(data["2fa_required"])
						{
							self.pendingSession = data.session;
							self.pendingUser = user;
							self.loginView.onVerificationRequired({user: user});
						}
						else
						{
							self.onTokens(data, user);
							self.getUser();
						}
                    },
                    function(data)
                    {
                        self.loginView.showError(data);
                    }));
            },
            enumerable: false
        },
		verify : {
            value: function(key)
            {
                var self = this;

                this.interactor.verify(this.pendingSession, key, new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
						self.pendingSession = null;
						self.onTokens(data, self.pendingUser);
						self.getUser();
                    },
                    function(data)
                    {
                        self.loginView.showError(data);
                    }));
            },
            enumerable: false
        },
        // Apply a token response from bling-proxy.py, persist it, and schedule its refresh.
        onTokens : {
            value: function(data, user)
            {
                var self = this;
                var stored = {
                    user: user,
                    access_token: data.access_token,
                    refresh_token: data.refresh_token,
                    hardware_id: data.hardware_id,
                    tier: data.tier,
                    account_id: data.account_id,
                    expires_at: Date.now() + (data.expires_in || 3600) * 1000
                };
                this.interactor.setToken(stored);
                this.applyToken(stored);

                clearTimeout(this.refreshTimer);
                var delay = Math.max(stored.expires_at - Date.now() - 120000, 10000);
                this.refreshTimer = setTimeout(function() { self.refresh(); }, delay);
            },
            enumerable: false
        },
        applyToken : {
            value: function(stored)
            {
                credentials.region = stored.tier;
                credentials.token = stored.access_token;
                credentials.account = {id: stored.account_id};
            },
            enumerable: false
        },
        refresh : {
            value: function(onDone)
            {
                var self = this;
                var stored = this.interactor.getToken();
                if(!stored || !stored.refresh_token)
                {
                    return;
                }

                this.interactor.refresh(stored.refresh_token, stored.hardware_id, new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
                        self.onTokens(data, stored.user);
                        if(onDone) onDone();
                    },
                    function(data)
                    {
                        // Refresh token rejected: keep hardware_id (avoids a new 2FA device) but drop the session.
                        if(data && data.status >= 400 && data.status < 500)
                        {
                            self.interactor.setToken({hardware_id: stored.hardware_id});
                        }
                        if(!onDone)
                        {
                            document.querySelector('#toast').MaterialSnackbar.showSnackbar({message: "Session expired, reload to sign in again", timeout: 10000});
                        }
                    }));
            },
            enumerable: false
        },
        checkToken : {
            value: function()
            {
                var self = this;
                var stored = this.interactor.getToken();
                if(!stored || !stored.refresh_token)
                {
                    return;
                }

                if(stored.access_token && stored.expires_at - Date.now() > 120000)
                {
                    this.onTokens({
                        access_token: stored.access_token, refresh_token: stored.refresh_token,
                        hardware_id: stored.hardware_id, tier: stored.tier, account_id: stored.account_id,
                        expires_in: (stored.expires_at - Date.now()) / 1000
                    }, stored.user);
                    this.getUser();
                }
                else
                {
                    this.refresh(function() { self.getUser(); });
                }
            },
            enumerable: false
        },
        getUser : {
            value: function()
            {
                var self = this;
                    
                this.interactor.getUser(new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
                        self.loginView.load(data);
                        self.homescreenView.onLogin(data);
                        self.activityView.onLogin(data);
                        self.networkView.onLogin(data);
                    },
                    function(data)
                    {
                        self.loginView.showError(data);
                    }));
            },
            enumerable: false
        },
    });

    presenters.LoginPresenter = LoginPresenter;
})(blink.presenters);
