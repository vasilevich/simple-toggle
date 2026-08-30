// Function to create a bot widget
function createBotWidget(botName, title, description, status) {
    var html = `
        <div class="col-4 bot-widget" id="${botName}-widget">
            <div class="card">
                <div class="card-body">
                    <button type="button" class="close delete-bot-widget-button d-none admin-mode" aria-label="Close">
                      <span aria-hidden="true">&times;</span>
                    </button>
                    <h5 class="card-title">${title}</h5>
                    <p class="card-text">${description}</p>
                    <input type="checkbox" id="${botName}-switch" data-toggle="toggle" data-on="ON" data-off="OFF">
                </div>
            </div>
        </div>
    `;
    $('#bot-control-panel').append(html);
    $(`#${botName}-switch`).bootstrapToggle(status ? 'on' : 'off');
    $(`#${botName}-switch`).change(function () {
        let status = this.checked;
        $.ajax({
            url: `/bot/${botName}`,
            type: 'POST',
            data: JSON.stringify({status: status}),
            contentType: 'application/json; charset=utf-8',
            dataType: 'json',
            async: false
        });
    });
    $(`#${botName}-widget .delete-bot-widget-button`).click(function () {
        $.ajax({
            url: `/bot/${botName}`,
            type: 'DELETE',
            success: function () {
                $(`#${botName}-widget`).remove();
            }
        });
    });
}

function showErrorModal(message) {
    $("#errorModalMessage").text(message);
    $("#errorModal").modal("show");
}

function showTokenPrompt(message = '') {
    $('body').html(`
        <div class="container d-flex justify-content-center align-items-center" style="min-height: 100vh">
            <div class="card" style="width: 100%; max-width: 420px">
                <div class="card-body">
                    <h5 class="card-title">Authentication required</h5>
                    <p class="card-text">Enter the access token to continue.</p>
                    ${message ? `<div class="alert alert-danger">${message}</div>` : ''}
                    <form id="token-form">
                        <div class="form-group">
                            <input id="token-input" type="password" class="form-control" placeholder="Token" autocomplete="current-password" required>
                        </div>
                        <button type="submit" class="btn btn-primary btn-block">Continue</button>
                    </form>
                </div>
            </div>
        </div>
    `);

    $('#token-form').on('submit', function (event) {
        event.preventDefault();
        const token = $('#token-input').val().trim();
        if (!token) return;

        const params = new URLSearchParams(window.location.search);
        params.set('token', token);
        if (!params.has('admin_mode')) params.set('admin_mode', 'false');
        window.location.replace(`${window.location.pathname}?${params.toString()}${window.location.hash}`);
    });

    $('#token-input').focus();
}

function applyAdminMode() {
    jQuery('.admin-mode').removeClass('d-none');
}

$(document).ready(function () {
    let urlParams = new URLSearchParams(window.location.search);
    let adminMode = urlParams.get('admin_mode');
    let token = urlParams.get('token');

    if (!token) {
        showTokenPrompt();
        return;
    }

    // if admin mode is not set
    if (adminMode === null || adminMode === undefined) {
        urlParams.set('admin_mode', false); // set adminMode to the url
        window.location.replace(location.href.split('?')[0] + '?' + urlParams.toString());
        return;
    }

    const isAdminModeSet = adminMode === 'true';

    // Configure AJAX setup
    $.ajaxSetup({
        beforeSend: function (xhr) {
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        },
        error: function (jqXHR, textStatus, errorThrown) {
            if (jqXHR.status === 401) {
                showTokenPrompt('That token was rejected.');
                return;
            }
            if (!$("#errorModal").hasClass('show')) {
                showErrorModal("An error occurred during the request.");
            }
        }
    });

    // Get the initial bot states
    $.getJSON(`/bots`, (data) => {
        data.forEach(bot => {
            createBotWidget(bot.botName, bot.title, bot.description, bot.status);
        });
        if (isAdminModeSet) {
            applyAdminMode();
        }
    });

    // Handle the creation of new bot widgets
    $('#create-widget-button').click(function () {
        let botName = $('#bot-name-input').val();
        let title = $('#bot-title-input').val();
        let description = $('#bot-description-input').val();
        $.ajax({
            url: `/bot/${botName}`,
            type: 'POST',
            data: JSON.stringify({
                title: title,
                description: description
            }),
            contentType: 'application/json; charset=utf-8',
            dataType: 'json',
            success: function () {
                createBotWidget(botName, title, description, false);
                $('#create-widget-modal').modal('hide');
                $('#create-widget-form')[0].reset();
                if (isAdminModeSet) {
                    applyAdminMode();
                }
            }
        });
    });
});
