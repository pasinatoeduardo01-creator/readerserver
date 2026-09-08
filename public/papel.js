(function () {
  var entrada = document.getElementById("foto");
  var previa = document.getElementById("previa");
  var botao = document.getElementById("botao-localizar");
  if (!entrada || !previa || !botao) return;
  var MAX = 1600;

  entrada.addEventListener("change", function () {
    var arquivo = entrada.files && entrada.files[0];
    if (!arquivo || !arquivo.type || arquivo.type.indexOf("image/") !== 0) return;
    botao.disabled = true;
    var img = new Image();
    var url = URL.createObjectURL(arquivo);
    img.onload = function () {
      var escala = Math.min(1, MAX / Math.max(img.width, img.height));
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * escala);
      canvas.height = Math.round(img.height * escala);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        URL.revokeObjectURL(url);
        if (blob && blob.size < arquivo.size) {
          var reduzido = new File([blob], "pagina.jpg", { type: "image/jpeg" });
          var dt = new DataTransfer();
          dt.items.add(reduzido);
          entrada.files = dt.files;
        }
        previa.src = canvas.toDataURL("image/jpeg", 0.6);
        previa.style.display = "block";
        botao.disabled = false;
      }, "image/jpeg", 0.85);
    };
    img.onerror = function () { URL.revokeObjectURL(url); botao.disabled = false; };
    img.src = url;
  });
})();
