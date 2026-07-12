import os
import threading
import json
import time
import obsws_python as obs
from dotenv import load_dotenv

load_dotenv()
class Game:
    """
    Manages the game logic for the Jeopardy-like quiz game.
    """

    def __init__(self, obs_client):
        self.obs_client = obs_client
        self.questions = [
            {"question": "What is the capital of France?", "answer": "Paris", "value": 100},
            {"question": "What is 2 + 2?", "answer": "4", "value": 100},
            {"question": "Who wrote 'Hamlet'?", "answer": "Shakespeare", "value": 200},
            # Add more questions as needed
        ]
        self.current_question_index = -1
        self.player_scores = {}
        self.accepting_answers = False
        
        self.main_scene_name = "Gameshow"
        self.question_source_name = "Question"
        self.create_question_source()
        self.scores_source_name = "Scores"
        self.create_scores_source()
        
        
    def create_scores_source(self):
        """
        Creates the text source for displaying scores in OBS.
        """
        try:
            self.obs_client.create_input(
                sceneName=self.main_scene_name,
                inputName=self.scores_source_name,
                inputKind="text_ft2_source_v2",
                inputSettings={
                    "text": "Scores",
                    "font": {
                        "face": "Arial",
                        "size": 36
                    },
                    "color": 4294967295  # White color (RGBA)
                },  
                sceneItemEnabled=True
            )
            print(f"Created '{self.scores_source_name}' text source in OBS")
        except Exception as e:
            print(f"Error creating scores source: {e}")
        

    def create_question_source(self):
        """
        Creates the text source for displaying questions in OBS.
        """
        try:
            self.obs_client.create_input(
                sceneName=self.main_scene_name,
                inputName=self.question_source_name,
                inputKind="text_ft2_source_v2",
                inputSettings={
                    "text": "Welcome to the Quiz Game!",
                    "font": {
                        "face": "Arial",
                        "size": 36
                    },
                    "color": 4294967295  # White color (RGBA)
                },
                sceneItemEnabled=True
            )
            print(f"Created '{self.question_source_name}' text source in OBS")
        except Exception as e:
            print(f"Error creating question source: {e}")

    def next_question(self):
        """
        Advances to the next question and updates the OBS overlay.
        """
        self.current_question_index += 1
        if self.current_question_index < len(self.questions):
            question = self.questions[self.current_question_index]
            self.display_question(question["question"])
            self.accepting_answers = True
        else:
            self.end_game()

    def display_question(self, question_text):
        """
        Displays the current question on the OBS overlay.
        """
        print("Displaying question:", question_text)
        # Update the text source named 'Question' in OBS
        self.obs_client.set_input_settings(
            "Question",
            {"text": question_text},
            overlay=False
        )

    def accept_answer(self, player_name, answer_text):
        """
        Accepts and validates an answer from a player.
        """
        if not self.accepting_answers:
            return
        correct_answer = self.questions[self.current_question_index]["answer"]
        value = self.questions[self.current_question_index]["value"]
        if answer_text.strip().lower() == correct_answer.strip().lower():
            print(f"{player_name} answered correctly!")
            self.player_scores[player_name] = self.player_scores.get(player_name, 0) + value
            self.update_scores()
            self.accepting_answers = False
            self.next_question()
        else:
            print(f"{player_name} answered incorrectly.")
            # Optionally deduct points or handle incorrect answers

    def update_scores(self):
        """
        Updates the player scores on the OBS overlay.
        """
        scores_text = "\n".join([f"{player}: {score}" for player, score in self.player_scores.items()])
        # Update the text source named 'Scores' in OBS
        self.obs_client.requests.SetInputSettings(
            inputName="Scores",
            inputSettings={"text": scores_text},
            overlay=False
        )

    def end_game(self):
        """
        Ends the game and displays the final results.
        """
        self.accepting_answers = False
        print("Game over!")
        self.obs_client.call(obs.requests.SetInputSettings(
            inputName="Question",
            inputSettings={"text": "Game Over!"},
            overlay=False
        ))
        # Optionally display final scores or other end-game information

def main():
    """
    Main function to run the quiz game.
    """

    obs_client = obs.ReqClient()

    game = Game(obs_client)

    def on_chat_message(data):
        """
        Handles incoming chat messages and passes them to the game logic.
        """
        try:
            username = data.user_name
            text = data.message
            if username and text:
                game.accept_answer(username, text)
        except AttributeError:
            print("Invalid chat message format")
            
    cl = obs.EventClient()
    cl.callback.register(on_chat_message)

    # Start the game
    game.next_question()

    # Keep the script running
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        obs_client.disconnect()

if __name__ == "__main__":
    main()
