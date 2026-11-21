(function(views)
{
    var self;

    function LoginView(presenter)
    {
        this.presenter = presenter;
    }

    Object.defineProperties(LoginView.prototype,
    {
        init : {
            value: function()
            {
                var self = this;

                $(document).ready(function ()
                {             
                    $("#login")[0].showModal();
                    $("#login form.login").submit(function(evt)
                    {
						$(this).find(".progress").show();
                        $(this).find(".submit").hide();
                        self.presenter.login($("#login .user").val(), $("#login .password").val());
                        evt.preventDefault();
                    });
					
					$("#login form.verify").submit(function(evt)
                    {
                        $(this).find(".progress").show();
                        $(this).find(".submit").hide();
                        self.presenter.verify($("#login .verification").val());
                        evt.preventDefault();
                    });
                    
                    componentHandler.upgradeAllRegistered();
                    
                    self.presenter.checkToken();
                    self.presenter.checkVersion();
                });
            },
            enumerable: false
        },
        load : {
            value: function(data)
            {
                $("#login .progress").hide();
                
                g_user = data;
                
                $(".avatar-dropdown > span").html(data.email);
                $("#login")[0].close();
                
                var dashboard = $("<a/>", {id: "dashboard", class: "link selected", href: "#", html: "<i class='fas fa-home'></i>"});
                dashboard.appendTo($(".drawer .navigation"));
            },
            enumerable: false
        },
		versionFound : {
            value: function(data)
            {
                $("#version .desktop .number").html(data);
            },
            enumerable: false
        },
		versionNotFound : {
            value: function(data)
            {
				// Desktop version check / redirect to BlingSetup.exe disabled:
				// the viewer is served without Bling Desktop, so /version 404s.
            },
            enumerable: false
        },
		onVerificationRequired : {
            value: function(data)
            {
				$("#login form.verify").find("span.email").html(data.user);
				$("#login form.login").hide();
				$("#login form.verify").show();
            },
            enumerable: false
        },
        showError : {
            value: function(data)
            {
                $("#login .progress").hide();
                $("#login .submit").show();
                
                document.querySelector('#toast').MaterialSnackbar.showSnackbar({message: data.message});
            },
            enumerable: false
        }
    });

    views.LoginView = LoginView;
})(blink.views);