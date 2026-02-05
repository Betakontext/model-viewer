This is Betakontext/model-viewer

A viewer app to explore 3D models and especially Gaussian Splattings online, including VR headset options, actually optimised for Meta Quest 3 (no other device tested yet).

It is build with Java Script using luma-web-library and Three.js frameworks.

index.hmtl delivers a little UI to switch between different models and is the base to showcase app.js in the browser.
overlay.html adds another layer, at the moment only containing some title/reference text.

In app.js is the actual script, delivering options to showcase and explore Gaussian Splattings f.e. LumaSplats loaded from LumaLabs servers, besides to other 3D model types as *.obj, *.gltf and *.fbx. 3D files can be replaced in models folder or put into any other folder, as long as you update the file paths  inside of app.js.

To explore locally download the whole repository and start a local http-server inside the root directory of the project, f.e. on Linux:
bash: python3 -m http.server 8080
Then open http://localhost:8080/ in your browser.
ctrl+c in the terminal closes the server.

Fork, explore and have fun
https://dev.betakontext.de
dev@betakontext.de
