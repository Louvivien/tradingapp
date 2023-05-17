from chatgpt_utils import ChatGPT_Client
import sys

if len(sys.argv) > 1:
    prompt = sys.argv[1]
    login = sys.argv[2]
    password = sys.argv[3]
else:
    print("No arguments passed")


def main():
    chatgpt = ChatGPT_Client(login, password)

    answer = chatgpt.interact(prompt)

    print(answer)

if __name__ == "__main__":
    main()







