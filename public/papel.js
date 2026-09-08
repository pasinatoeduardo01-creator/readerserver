(function () {
  var entrada = document.getElementById("foto");
  var previa = document.getElementById("previa");
  var botao = document.getElementById("botao-localizar");
  if (!entrada || !previa || !botao) return;
  var MAX = 1600;

  // A CSP do servidor é `img-src 'self' data:`: uma URL `blob:` é recusada pelo
  // navegador, o `onerror` disparava e a foto original (vários MB) ia inteira.
  // Por isso a decodificação é por createImageBitmap, com FileReader → data: de reserva.
  function porFileReader(arquivo) {
    return new Promise(function (ok, falha) {
      var leitor = new FileReader();
      leitor.onload = function () {
        var img = new Image();
        img.onload = function () { ok(img); };
        img.onerror = function () { falha(new Error("imagem ilegível")); };
        img.src = leitor.result;
      };
      leitor.onerror = function () { falha(new Error("não consegui ler o arquivo")); };
      leitor.readAsDataURL(arquivo);
    });
  }

  function decodificar(arquivo) {
    if (typeof createImageBitmap === "function") {
      try {
        return createImageBitmap(arquivo).catch(function () { return porFileReader(arquivo); });
      } catch (e) {
        // Navegador sem createImageBitmap para File: segue pelo FileReader.
      }
    }
    return porFileReader(arquivo);
  }

  function reduzir(imagem) {
    var escala = Math.min(1, MAX / Math.max(imagem.width, imagem.height));
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(imagem.width * escala);
    canvas.height = Math.round(imagem.height * escala);
    canvas.getContext("2d").drawImage(imagem, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  entrada.addEventListener("change", function () {
    var arquivo = entrada.files && entrada.files[0];
    if (!arquivo || !arquivo.type || arquivo.type.indexOf("image/") !== 0) return;
    botao.disabled = true;
    decodificar(arquivo)
      .then(function (imagem) {
        var canvas = reduzir(imagem);
        if (typeof imagem.close === "function") imagem.close();
        return new Promise(function (ok) {
          canvas.toBlob(function (blob) {
            // Só troca o arquivo do formulário se a redução valeu a pena.
            if (blob && blob.size < arquivo.size) {
              try {
                var dt = new DataTransfer();
                dt.items.add(new File([blob], "pagina.jpg", { type: "image/jpeg" }));
                entrada.files = dt.files;
              } catch (e) {
                // Sem DataTransfer (navegador antigo): mantém o arquivo original.
              }
            }
            previa.src = canvas.toDataURL("image/jpeg", 0.6);
            previa.style.display = "block";
            ok();
          }, "image/jpeg", 0.85);
        });
      })
      .catch(function () {
        // Não deu para decodificar: o arquivo original segue no formulário.
      })
      .then(function () { botao.disabled = false; });
  });
})();
