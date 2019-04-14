package de.jluger.mediarecorderstreaming;

import spark.Spark;

/**
 * Starts a server on port 5060 (usable from all ip adress of the computer) and
 * provides a web gui and a server for streaming a video to several clients.<br>
 * <br>
 * For more details see main.js
 *
 * @author J&ouml;rg Luger
 *
 */
public class MediaRecorderStreamingServer {
	public static void main(String[] args) {
		Spark.port(5060);
		Spark.externalStaticFileLocation("web");
		Spark.webSocket("/api/signal", SignalWebsocket.class);
		Spark.init();
	}
}
