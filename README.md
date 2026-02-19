# MODEL-VIEWER

A browser based viewer app to explore Gaussian Splattings and other 3D models online including WebXR / VR options, atm tested with and optimised for Meta Quest 3. Build with Java Script using Three.js and the luma-webGL-library and based the luma-webGL-library framework. -> https://github.com/lumalabs/luma-web-examples

It includes WebXR / VR options, at the moment only tested with and optimised for Meta Quest 3.
---------------

app.js delivers options to showcase and explore Gaussian Splattings f.e. LumaSplats loaded from from local or external servers, besides to other 3D model types as *.obj, *.gltf and *.fbx. 3D files can be replaced inside the /models folder or put into any other folder, as long as you update the file paths inside of app.js.

index.hmtl delivers a little UI to switch between different models and is the base to showcase app.js in the browser.

overlay.html adds another layer, atm only containing some title/reference text.

---------------
Online version: https://dev.betakontext.de/model-viewer
---------------
To explore models locally download the whole repository and start a local http-server inside the root directory of the project, f.e. on Linux:

	python3 -m http.server 8000

Then open http://localhost:8000/ in your browser.
ctrl+c in the terminal closes the server.
---------------
---------------
If you want to develop it further feel free to fork, explore and have fun.
---------------
---------------
The project got realized with AI assistance and published under MIT licence.
CONTACT: Christoph Medicus | dev@betakontext.de
