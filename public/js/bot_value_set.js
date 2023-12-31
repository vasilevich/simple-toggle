(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const valueToken = urlParams.get('valueToken');
    const valueUrl = `${location.protocol}//${location.host}/bot/get_value/${encodeURIComponent(valueToken)}?token=${encodeURIComponent(token)}&only_value=true`;
    $('#value-url')
        .text(valueUrl)
        .attr('href', valueUrl);


// Fetch current key, description, and value
    $.get(`/bot/get_value/${encodeURIComponent(valueToken)}?token=${encodeURIComponent(token)}`, (data) => {
        $('#key').text(data.key);
        $('#description').html(data.description);
        $('#value').val(data.value);
    });

// Update value on form submit
    $('#value-form').submit((e) => {
        e.preventDefault();
        const newValue = $('#value').val();
        $.ajax({
            url: `/bot/set_value/${encodeURIComponent(valueToken)}?token=${encodeURIComponent(token)}`,
            type: 'POST',
            data: JSON.stringify({value: newValue}),
            contentType: 'application/json; charset=utf-8',
            dataType: 'json',
        })
            .done(function () {
                $('#success-message').removeClass('d-none');
            })
            .fail(function () {
                alert("An error occurred while setting the value. Please try again.");
            });
    });
})();
