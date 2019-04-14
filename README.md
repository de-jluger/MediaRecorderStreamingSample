## What is it?
This is a minimal example of using WebRTC MediaRecorder and websockets for streaming a live video. Please see `web/main.js` for a detailed description.

## Requirments
To run the program you will not only need java and maven but also a working webcam.

## How to build
mvn clean package

## How to start
Move into the project folder and execute  
`java -jar target/mediarecorderstreamingsample-0.0.1-SNAPSHOT.jar`  
You can't go into the target folder as the jar needs some files in the web folder.

If started successfully go to  
`http://localhost:5060/`  
and create a room. Open another tab with the same url and join the created room.
To do this copy the room key from the first tab and enter a user name.
Then click "Start stream" in the first tab. Allow the browser to access your webcam.
Now you should see yourself in the second tab. There is no video output in the first tab.