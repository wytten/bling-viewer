(function(presenters)
{
    function HomescreenPresenter(Context)
    {
        this.interactor = Context.getHomescreenInteractor();
        this.cameraView = Context.getCameraPresenter().cameraView;
	   
        this.view = Context.getHomescreenView(this);
        this.view.init();
    }

    Object.defineProperties(HomescreenPresenter.prototype,
    {
        get : {
            value: function(onSuccess)
            {
                var self = this;
                    
                this.interactor.get(new blink.listeners.BaseDecisionListener(
                    function(data)
                    {
                        var types = {};
                        $.each([].concat(data.cameras || [], data.owls || [], data.doorbells || []), function(i, c)
                        {
                            if(c.type) types[c.id] = c.type;
                        });
                        cameraTypes.resolve(types);

                        onSuccess(data);
						
						self.cameraView.onOwls(data.owls);
                    },
                    function(data)
                    {
                        cameraTypes.resolve({});
                        self.view.showError(data);
                    }));
            },
            enumerable: false
        }
    });

    presenters.HomescreenPresenter = HomescreenPresenter;
})(blink.presenters);