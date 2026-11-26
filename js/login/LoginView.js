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
                        self.presenter.verify($("#login .verification").val(), $("#login .remember").prop("checked"));
                        evt.preventDefault();
                    });
                    
                    $("#signout").click(function(evt)
                    {
                        self.presenter.signOut();
                        evt.preventDefault();
                    });

                    componentHandler.upgradeAllRegistered();
                    
                    self.presenter.checkToken();
                    self.presenter.prefillLogin();
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
                $("#signout").show();
                
                var dashboard = $("<a/>", {id: "dashboard", class: "link selected", href: "#", title: "Cameras", html: "<i class='fas fa-home'></i>"});
                dashboard.appendTo($(".drawer .navigation"));
            },
            enumerable: false
        },
		// A public proxy remembers the device in this browser's cookie, not on the server.
		rememberInBrowser : {
            value: function()
            {
                var label = $("#login .remember").closest("label");
                label.attr("title", "Keeps Blink's login cookies in this browser so its next login can skip this step");
                label.find(".mdl-checkbox__label").text("Don't ask again in this browser");
            },
            enumerable: false
        },
		// Fill in the last login name (unless something was typed already) and go to the password.
		prefillUser : {
            value: function(email)
            {
                var user = $("#login .user");
                if(user.val()) return;
                user.val(email);
                var field = user.closest(".mdl-textfield")[0];
                if(field && field.MaterialTextfield) field.MaterialTextfield.checkDirty();  // float the label
                $("#login .password").focus();
            },
            enumerable: false
        },
		onVerificationRequired : {
            value: function(data)
            {
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