package de.jluger.mediarecorderstreaming;

import java.io.IOException;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.stream.Collectors;

import org.eclipse.jetty.websocket.api.Session;
import org.eclipse.jetty.websocket.api.annotations.OnWebSocketClose;
import org.eclipse.jetty.websocket.api.annotations.OnWebSocketConnect;
import org.eclipse.jetty.websocket.api.annotations.OnWebSocketMessage;
import org.eclipse.jetty.websocket.api.annotations.WebSocket;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.google.gson.Gson;

/**
 * Implements the websocket handler that brokers the video data between a sender
 * and one or more receivers.
 * 
 * @author J&ouml;rg Luger
 *
 */
@WebSocket
public class SignalWebsocket {
	private static final Logger LOG = LoggerFactory.getLogger(SignalWebsocket.class);
	private static final ConcurrentHashMap<String, Room> roomMap = new ConcurrentHashMap<>();
	private Gson gson = new Gson();

	/**
	 * Called when a clients connects.
	 * 
	 * @param session The session of the client.
	 */
	@OnWebSocketConnect
	public void connected(Session session) {
		LOG.debug("connected");
	}

	/**
	 * Called when a clients disconnects. Removes the client from any rooms or even
	 * the room when the client is the streamer.
	 * 
	 * @param session The session of the client.
	 */
	@OnWebSocketClose
	public void closed(Session session, int statusCode, String reason) {
		LOG.debug("closed");
		List<Room> deleteRoomList = roomMap.values().stream().filter(room -> room.getStreamer().equals(session))
				.collect(Collectors.toList());
		deleteRoomList.forEach(room -> roomMap.remove(room.getKey()));
		roomMap.values().forEach(room -> room.deleteViewer(session));
	}

	/**
	 * This methods handles the message brokering between the streamer and the
	 * receivers.
	 * 
	 * @param session The session of the sender.
	 * @param message The message beeing sent.
	 * @throws IOException Thrown when there is an error while sending a message to
	 *                     another client.
	 */
	@OnWebSocketMessage
	public void message(Session session, String message) throws IOException {
		SignalMessage signalMessage = gson.fromJson(message, SignalMessage.class);
		if ("CreateRoom".equals(signalMessage.getOperation())) {
			createRoom(session);
		}
		if ("DeleteRoom".equals(signalMessage.getOperation())) {
			deleteRoom(signalMessage);
		}
		if ("JoinRoom".equals(signalMessage.getOperation())) {
			joinRoom(session, signalMessage);
		}
		if ("LeaveRoom".equals(signalMessage.getOperation())) {
			leaveRoom(session, signalMessage);
		}
		if ("StreamData".equals(signalMessage.getOperation())) {
			streamData(message, signalMessage);
		}
	}

	/**
	 * Send the video stream data from the streamer to the receiver.
	 * 
	 * @param message       The message containing the video and all required meta
	 *                      data.
	 * @param signalMessage Contains a serialized instance of {@link StreamData}
	 *                      which contains the room key.
	 * @throws IOException Thrown when there is an error while sending a message to
	 *                     another client.
	 */
	private void streamData(String message, SignalMessage signalMessage) throws IOException {
		String payload = signalMessage.getPayload();
		StreamData streamData = gson.fromJson(payload, StreamData.class);
		// using good old for method as sendString throws IOException
		for (Session otherSession : roomMap.get(streamData.getRoomKey()).getViewerSet()) {
			otherSession.getRemote().sendString(message);
		}
	}

	/**
	 * Message that a receiver leaves a room.
	 * 
	 * @param session       The session of the receiver.
	 * @param signalMessage The message with the room key of the room to leave.
	 */
	private void leaveRoom(Session session, SignalMessage signalMessage) {
		String key = signalMessage.getPayload();
		Optional.ofNullable(roomMap.get(key)).ifPresent(room -> room.deleteViewer(session));
	}

	/**
	 * Handles the joining of a client to a room. This client wants to receive video
	 * data.
	 * 
	 * @param session       The session of the receiver.
	 * @param signalMessage JSON that deserializes to {@link SignalMessage}.
	 * @throws IOException Thrown when there is an error while sending a message to
	 *                     another client.
	 */
	private void joinRoom(Session session, SignalMessage signalMessage) throws IOException {
		ViewerJoinData joinData = gson.fromJson(signalMessage.getPayload(), ViewerJoinData.class);
		String key = joinData.getKey();
		if (!roomMap.containsKey(key)) {
			String response = gson.toJson(new SignalMessage("Error", "Room " + key + " doesn't exists."));
			session.getRemote().sendString(response);
			return;
		}
		roomMap.get(key).addViewer(session);
		String response = gson.toJson(new SignalMessage("JoindedRoom", joinData.getUsername()));
		roomMap.get(key).getStreamer().getRemote().sendString(response);
	}

	/**
	 * Signals the viewers of a room that the room will be deleted and then removes
	 * it from the room map.
	 * 
	 * @param signalMessage The message with the room key to delete.
	 * @throws IOException Thrown when there is an error while sending a message to
	 *                     another client.
	 */
	private void deleteRoom(SignalMessage signalMessage) throws IOException {
		String key = signalMessage.getPayload();
		String response = gson.toJson(new SignalMessage("DeletedRoom", key));
		for (Session viewer : roomMap.get(key).getViewerSet()) {
			viewer.getRemote().sendString(response);
		}
		roomMap.remove(key);
	}

	/**
	 * Handle the create room message of a streaming client (Has a camera and wants
	 * to send the camera data to other clients).
	 * 
	 * @param session The session of the sender.
	 * @throws IOException Thrown when there is an error while sending a message to
	 *                     another client.
	 */
	private void createRoom(Session session) throws IOException {
		int randomInt = new SecureRandom().nextInt();
		if (randomInt < 0) {
			randomInt *= -1;
		}
		String key = Integer.toString(randomInt);
		if (key.length() > 4) {
			key = key.substring(0, 4);
		}
		roomMap.put(key, new Room(key, session));
		String response = gson.toJson(new SignalMessage("CreatedRoom", key));
		session.getRemote().sendString(response);
	}

	/**
	 * A room consists of one streamer and multiple viewers/receivers. In order to
	 * have multiple rooms each room needs a key to identify it.
	 */
	private static class Room {
		private String key;
		private Session streamer;
		private Set<Session> viewerSet = new HashSet<>();

		/**
		 * Creates a new room.
		 * 
		 * @param key      The key identifying the room.
		 * @param streamer The user that wants to stream video data.
		 */
		public Room(String key, Session streamer) {
			this.key = key;
			this.streamer = streamer;
		}

		public String getKey() {
			return key;
		}

		public Session getStreamer() {
			return streamer;
		}

		/**
		 * Retuns the viewer set. It is not allowed to modify this this.
		 * 
		 * @return The viewer set.
		 */
		public Set<Session> getViewerSet() {
			synchronized (viewerSet) {
				return Collections.unmodifiableSet(viewerSet);
			}
		}

		/**
		 * Add a viewer to this room.
		 * 
		 * @param viewer The viewer to add.
		 */
		public void addViewer(Session viewer) {
			synchronized (viewerSet) {
				viewerSet.add(viewer);
			}
		}

		/**
		 * Removes a viewer from this room.
		 * 
		 * @param viewer The viewer to remove.
		 */
		public void deleteViewer(Session viewer) {
			synchronized (viewerSet) {
				viewerSet.remove(viewer);
			}
		}
	}

	/**
	 * The data of a client connecting as a viewer of the video data. Contains the
	 * session key and a user name.
	 */
	private static class ViewerJoinData {
		private String key;
		private String username;

		public String getKey() {
			return key;
		}

		public String getUsername() {
			return username;
		}

	}

	/**
	 * Contains base64 encoded video data for a room. As the recoreded video chunks
	 * are larger than the limit of websockets the streamer has to split them and
	 * the viewer must collect all until the last one before processing them. Most
	 * data aren't used at the server (except roomKey) but must be present in the
	 * class to be able to deserialize it.
	 */
	private static class StreamData {
		private String roomKey;
		private String videoData;
		private boolean last;

		public String getRoomKey() {
			return roomKey;
		}

		public String getVideoData() {
			return videoData;
		}

		public boolean isLast() {
			return last;
		}
	}

	/**
	 * The minimal container for a message exchange between a client and the server.
	 */
	private static class SignalMessage {
		private String operation;
		private String payload;

		/**
		 * Creates a new instance.
		 * 
		 * @param operation The operation to perform.
		 * @param payload   The data that is specific to the operation.
		 */
		public SignalMessage(String operation, String payload) {
			this.operation = operation;
			this.payload = payload;
		}

		public String getOperation() {
			return operation;
		}

		public String getPayload() {
			return payload;
		}
	}
}
