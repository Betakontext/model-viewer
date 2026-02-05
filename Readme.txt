This is Betakontext/model-viewer

A Java Scrip based viewer app to explore 3D models and Gaussian Splattings online, including VR options. Build with Java Script, luma-web-library and Three.js frameworks.

index.hmtl delivers a little UI to switch between different models and is the base to showcase app.js in the browser.

overay.html adds a flexible layer, atm containing only some description text.

app.js is the actual app, giving you the option to showcase Gaussian Splattings f.e. LumaSplats loaded from LumaLabs servers, besides other 3D model types as *.obj, *.gltf and *.fbx. 3D files can be placed in models folder or in any other folder you the adress inside app.js.

To explore locally download the whole repository and start a local http-server inside the root directory of the project, f.e. on Linux:
bash: python3 -m http.server 8080
Then open http://localhost:8080/ in your browser.
ctrl+c in the terminal closes the server.

Fork, explore and have fun
https://dev.betakontext.de
dev@betakontext.de
