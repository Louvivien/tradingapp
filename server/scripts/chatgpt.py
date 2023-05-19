from chatgpt_utils import ChatGPT_Client
import sys

if len(sys.argv) > 1:
    input = sys.argv[1]
    login = sys.argv[2]
    password = sys.argv[3]

else:
    print("No arguments passed")

def filter_to_bmp(input_string):
    return ''.join(c for c in input_string if ord(c) < 0x10000)


def main():
    chatgpt = ChatGPT_Client(login, password)
    
    prompt = filter_to_bmp(input)
    # print('\n' + prompt + '\n')
    answer = chatgpt.interact(prompt)

    print(answer)  

if __name__ == "__main__":
    main()







