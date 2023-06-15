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

function applyAdminMode() {
    jQuery('.admin-mode').removeClass('d-none');
}

$(document).ready(function () {
    let urlParams = new URLSearchParams(window.location.search);
    let adminMode = urlParams.get('admin_mode');
    let token = urlParams.get('token');
    // if admin mode is not set
    if (adminMode === null || adminMode === undefined) {
        urlParams.set('admin_mode', false); // set adminMode to the url
        // set adminMode to the url
        location.href = location.href.split('?')[0] + '?' + urlParams.toString();
    }

    const isAdminModeSet = adminMode === 'true';

    // Configure AJAX setup
    $.ajaxSetup({
        beforeSend: function (xhr) {
            xhr.setRequestHeader('Authorization', 'Bearer ' + token);
        },
        error: function (jqXHR, textStatus, errorThrown) {
            if (!$("#errorModal").hasClass('show')) {
                showErrorModal("An error occurred during the request. Please provide a valid token.");
            }
        }
    });

    // Get the initial bot states
    $.getJSON(`/bots`, (data) => {
        data.forEach(bot => {
            createBotWidget(bot.botName, bot.title, bot.description, bot.status);
            if (isAdminModeSet) {
                applyAdminMode();
            }
        });
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
